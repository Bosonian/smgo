using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SuperMemoAssistant.Interop.Plugins;
using SuperMemoAssistant.Interop.SuperMemo.Core;
using SuperMemoAssistant.Interop.SuperMemo.Elements.Builders;
using SuperMemoAssistant.Interop.SuperMemo.Elements.Models;
using SuperMemoAssistant.Interop.SuperMemo.Content.Contents;
using SuperMemoAssistant.Interop.SuperMemo.Content.Models;
using SuperMemoAssistant.Interop.SuperMemo.Elements.Types;
using SuperMemoAssistant.Services;

namespace SuperMemoAssistant.Plugins.SMGo
{
  // ReSharper disable once UnusedMember.Global
  // ReSharper disable once ClassNeverInstantiated.Global
  public class SMGoPlugin : SMAPluginBase<SMGoPlugin>
  {
    public override string Name        => "SMGo";
    public override bool   HasSettings => false;

    private const int    Port    = 3001;
    private const string DataDir = @"C:\SuperMemo\SMGo";

    private HttpListener?   _listener;
    private Thread?         _serverThread;
    private CancellationTokenSource? _cts;
    private FileSystemWatcher? _gradesWatcher;
    private FileSystemWatcher? _extractsWatcher;
    private FileSystemWatcher? _itemsWatcher;
    private FileSystemWatcher? _dismissesWatcher;
    private Timer? _applyDebounce;

    // Supabase cloud sync
    private static readonly HttpClient _http = new HttpClient();
    private string? _supaUrl;
    private string? _supaKey;
    private Timer?  _supaTimer;

    // Set from SMA's selected collection event. Never fall back to a hard-coded
    // collection: SuperMemo element IDs are only meaningful inside one collection.
    private readonly object _collectionGate = new object();
    private CollectionContext? _activeCollection;
    private long _nextCollectionGeneration;
    private int     _pollInProgress = 0; // 0=idle, 1=running — prevents overlapping polls

    // ── SMA lifecycle ─────────────────────────────────────────────────────

    protected override void OnSMStarted(bool wasSMAlreadyStarted)
    {
      base.OnSMStarted(wasSMAlreadyStarted);
      Serilog.Log.Information("SMGo OnSMStarted (wasSMAlreadyStarted={Already})", wasSMAlreadyStarted);

      LoadConfig();

      // Give SM 2 seconds to fully settle before touching element window
      Task.Delay(2000).ContinueWith(_ =>
      {
        try { ApplyPendingGrades(); }    catch { }
        try { ApplyPendingExtracts(); }  catch { }
        try { ApplyPendingItems(); }     catch { }
        try { ApplyPendingDismisses(); } catch { }
      });

      // Export today's cards and extract new PDF highlights to Supabase
      Task.Delay(5000).ContinueWith(_ => { RunExportCloud(); RunHighlightExtract(); });

      StartHttpServer();
      StartFileWatchers();
      StartSupabasePoller();
    }

    protected override void OnCollectionSelected(SMCollection col)
    {
      base.OnCollectionSelected(col);
      try
      {
        CollectionContext selected;
        lock (_collectionGate)
        {
          var root = col.GetRootDirPath();
          selected = new CollectionContext(root, BuildCollectionId(root), col.Name,
            ++_nextCollectionGeneration);
          Volatile.Write(ref _activeCollection, selected);
        }
        Serilog.Log.Information("SMGo active collection: {Name} ({Id}) at {Root}",
          selected.Name, selected.Id, selected.Root);
        // A collection can be changed while SuperMemo is running. Move local
        // queue watchers with it; the poller itself filters each request.
        if (_listener != null)
        {
          StopFileWatchers();
          StartFileWatchers();
          StopSupabasePoller();
          StartSupabasePoller();
          Task.Delay(5000).ContinueWith(_ => { RunExportCloud(); RunHighlightExtract(); });
        }
      }
      catch (Exception ex)
      {
        lock (_collectionGate)
        {
          ++_nextCollectionGeneration;
          Volatile.Write(ref _activeCollection, null);
        }
        Serilog.Log.Warning(ex, "SMGo could not determine the selected collection");
      }
    }

    protected override void OnSMStopped()
    {
      base.OnSMStopped();
      StopHttpServer();
      StopFileWatchers();
      StopSupabasePoller();
    }

    protected override void Dispose(bool disposing)
    {
      if (disposing)
      {
        StopHttpServer();
        StopFileWatchers();
        StopSupabasePoller();
        _applyDebounce?.Dispose();
      }
      base.Dispose(disposing);
    }

    // ── Config ────────────────────────────────────────────────────────────────

    private void LoadConfig()
    {
      var configFile = Path.Combine(DataDir, "config.json");
      if (!File.Exists(configFile)) return;
      try
      {
        var cfg = JObject.Parse(File.ReadAllText(configFile));
        _supaUrl = cfg["supabaseUrl"]?.ToString()?.TrimEnd('/');
        _supaKey = cfg["supabaseKey"]?.ToString();
        if (!string.IsNullOrEmpty(_supaUrl) && !string.IsNullOrEmpty(_supaKey))
          Serilog.Log.Information("SMGo Supabase sync enabled: {Url}", _supaUrl);
      }
      catch (Exception ex) { Serilog.Log.Warning(ex, "SMGo failed to load config.json"); }
    }

    // ── Auto-export today's cards to Supabase ────────────────────────────────

    private static string BuildCollectionId(string collectionRoot)
    {
      var canonical = Path.GetFullPath(collectionRoot.Normalize(NormalizationForm.FormC))
        .Replace('/', '\\').ToLowerInvariant();
      if (!Regex.IsMatch(canonical, @"^[a-z]:\\$")) canonical = canonical.TrimEnd('\\');
      var name = Path.GetFileName(canonical);
      var decomposed = name.Normalize(NormalizationForm.FormKD);
      var folded = new StringBuilder();
      foreach (var c in decomposed)
        if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) folded.Append(c);
      var slug = Regex.Replace(folded.ToString().ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
      if (string.IsNullOrEmpty(slug)) slug = "collection";
      using var sha = SHA256.Create();
      var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(canonical));
      var hash = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant().Substring(0, 12);
      return $"collection-{slug}-{hash}";
    }

    private sealed class CollectionContext
    {
      public CollectionContext(string root, string id, string name, long generation)
      { Root = root; Id = id; Name = name; Generation = generation; }
      public string Root { get; }
      public string Id { get; }
      public string Name { get; }
      public long Generation { get; }
    }

    private CollectionContext? CaptureCollectionContext() => Volatile.Read(ref _activeCollection);

    private bool IsCurrent(CollectionContext context)
      => ReferenceEquals(context, Volatile.Read(ref _activeCollection));

    private bool HasCollectionContext()
    {
      if (CaptureCollectionContext() != null) return true;
      Serilog.Log.Warning("SMGo has no active collection context; command was not processed");
      return false;
    }

    private bool MatchesActiveCollection(string? collectionId)
    {
      if (!HasCollectionContext()) return false;
      return string.Equals(collectionId, CaptureCollectionContext()?.Id, StringComparison.Ordinal);
    }

    private bool MatchesActiveCollection(JObject payload)
      => MatchesActiveCollection(payload["collectionId"]?.ToString());

    private static bool HasProtocolV2(JObject payload)
      => payload["protocolVersion"]?.Value<int>() == 2;

    private bool MatchesActiveCollection(JObject payload, CollectionContext context)
      => IsCurrent(context)
        && HasProtocolV2(payload)
        && string.Equals(payload["collectionId"]?.ToString(), context.Id, StringComparison.Ordinal);

    private string QueueDir(string kind)
    {
      if (!HasCollectionContext()) throw new InvalidOperationException("No active collection");
      return Path.Combine(DataDir, "queues", CaptureCollectionContext()!.Id, kind);
    }

    private string QueueDir(string kind, CollectionContext context)
      => Path.Combine(DataDir, "queues", context.Id, kind);

    private bool ValidateIncomingCollection(JObject payload, HttpListenerResponse res)
    {
      if (MatchesActiveCollection(payload) && HasProtocolV2(payload)) return true;
      SendJson(res, new { error = "Command collection or protocol does not match the active SuperMemo collection." }, 409);
      return false;
    }

    private bool TryCaptureIncomingCollection(JObject payload, HttpListenerResponse res, out CollectionContext? context)
    {
      context = CaptureCollectionContext();
      if (context != null && MatchesActiveCollection(payload, context)) return true;
      SendJson(res, new { error = "Command collection or protocol does not match the active SuperMemo collection." }, 409);
      return false;
    }

    private void RunExportCloud()
    {
      var context = CaptureCollectionContext();
      if (context == null) return;
      var scriptPath = Path.Combine(DataDir, "export-cloud.js");
      if (!File.Exists(scriptPath)) return;
      try
      {
        var psi = new ProcessStartInfo
        {
          FileName               = "cmd.exe",
          Arguments              = $"/c node \"{scriptPath}\"",
          WorkingDirectory       = DataDir,
          UseShellExecute        = false,
          CreateNoWindow         = true,
          RedirectStandardOutput = true,
          RedirectStandardError  = true,
        };
        psi.EnvironmentVariables["SMGO_COLLECTION_PATH"] = context.Root;
        psi.EnvironmentVariables["SMGO_COLLECTION_ID"] = context.Id;
        psi.EnvironmentVariables["SMGO_COLLECTION_NAME"] = context.Name;
        using var proc = Process.Start(psi);
        if (proc == null) return;
        var output = proc.StandardOutput.ReadToEnd();
        var error  = proc.StandardError.ReadToEnd();
        proc.WaitForExit(30000);
        if (!string.IsNullOrWhiteSpace(output)) Serilog.Log.Information("{Output}", output.Trim());
        if (!string.IsNullOrWhiteSpace(error))  Serilog.Log.Warning("export-cloud stderr: {Error}", error.Trim());
      }
      catch (Exception ex) { Serilog.Log.Warning(ex, "SMGo RunExportCloud failed"); }
    }

    private void RunHighlightExtract()
    {
      var context = CaptureCollectionContext();
      if (context == null) return;
      var scriptPath = Path.Combine(DataDir, "highlight-extract.js");
      if (!File.Exists(scriptPath)) return;
      try
      {
        var psi = new ProcessStartInfo
        {
          FileName               = "cmd.exe",
          Arguments              = $"/c node \"{scriptPath}\"",
          WorkingDirectory       = DataDir,
          UseShellExecute        = false,
          CreateNoWindow         = true,
          RedirectStandardOutput = true,
          RedirectStandardError  = true,
        };
        psi.EnvironmentVariables["SMGO_COLLECTION_PATH"] = context.Root;
        psi.EnvironmentVariables["SMGO_COLLECTION_ID"] = context.Id;
        psi.EnvironmentVariables["SMGO_COLLECTION_NAME"] = context.Name;
        using var proc = Process.Start(psi);
        if (proc == null) return;
        var output = proc.StandardOutput.ReadToEnd();
        var error  = proc.StandardError.ReadToEnd();
        proc.WaitForExit(60000);
        if (!string.IsNullOrWhiteSpace(output)) Serilog.Log.Information("{Output}", output.Trim());
        if (!string.IsNullOrWhiteSpace(error))  Serilog.Log.Warning("highlight-extract stderr: {Error}", error.Trim());
      }
      catch (Exception ex) { Serilog.Log.Warning(ex, "SMGo RunHighlightExtract failed"); }
    }

    // ── Supabase poller ───────────────────────────────────────────────────────

    private void StartSupabasePoller()
    {
      if (string.IsNullOrEmpty(_supaUrl) || string.IsNullOrEmpty(_supaKey)) return;
      // Poll after 15s on start, then every 30s
      _supaTimer = new Timer(_ => Task.Run(PollSupabaseAsync), null,
        TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(30));
    }

    private void StopSupabasePoller()
    {
      _supaTimer?.Dispose();
      _supaTimer = null;
    }

    private async Task PollSupabaseAsync()
    {
      if (string.IsNullOrEmpty(_supaUrl) || string.IsNullOrEmpty(_supaKey)) return;
      var context = CaptureCollectionContext();
      if (context == null) return;
      // Prevent a second poll from starting while the previous one is still processing
      if (System.Threading.Interlocked.Exchange(ref _pollInProgress, 1) == 1) return;
      try
      {
        var req = new HttpRequestMessage(HttpMethod.Get,
          $"{_supaUrl}/rest/v1/smgo_queue?applied=eq.false&collection_id=eq.{Uri.EscapeDataString(context.Id)}&order=id.asc");
        req.Headers.Add("apikey", _supaKey);
        req.Headers.Add("Authorization", $"Bearer {_supaKey}");

        using var resp = await _http.SendAsync(req);
        if (!resp.IsSuccessStatusCode) return;

        var items = JArray.Parse(await resp.Content.ReadAsStringAsync());
        if (items.Count == 0) return;

        Serilog.Log.Information("SMGo Supabase: {Count} items to apply", items.Count);

        foreach (JObject item in items)
        {
          var id      = item["id"]?.ToString() ?? "";
          var type    = item["type"]?.ToString() ?? "";
          var collectionId = item["collection_id"]?.ToString();
          var payload = item["payload"] as JObject;
          if (payload == null || string.IsNullOrEmpty(id)) continue;
          if (!string.Equals(collectionId, context.Id, StringComparison.Ordinal)
            || !MatchesActiveCollection(payload, context)
            || !string.Equals(payload["commandId"]?.ToString(), id, StringComparison.Ordinal))
          {
            Serilog.Log.Warning("SMGo rejected queue item {Id}: invalid collection, protocol, or command ID", id);
            continue;
          }

          bool applied = false;
          try
          {
            lock (_collectionGate)
            {
              if (!IsCurrent(context)) break;
              switch (type)
              {
                case "extract":             applied = ApplyOneExtract(payload, context);       break;
                case "pdf-extract-create":  applied = ApplyOnePdfExtract(payload, context);    break;
                case "image-extract":       applied = ApplyOneImageExtract(payload, context); break;
                case "qa":                  applied = ApplyOneQA(payload, context);            break;
                case "cloze":               applied = ApplyOneCloze(payload, context);         break;
                case "grade":               applied = ApplyOneGrade(payload, context);         break;
                case "dismiss":             applied = ApplyOneDismiss(payload, context);       break;
                case "priority":            applied = ApplyOnePriority(payload, context);      break;
                case "edit":                applied = ApplyOneEdit(payload, context);           break;
              }
            }
          }
          catch (Exception ex)
          {
            Serilog.Log.Warning(ex, "SMGo Supabase: failed to apply item {Id}", id);
          }

          // Grade, dismiss, priority: mark applied regardless of success — these
          // can silently fail (grade outside review session, element not in priority queue);
          // retrying forever creates an infinite loop and duplicates create-type items.
          if (applied) await MarkSupabaseApplied(id, context);
          await Task.Delay(600);
        }
      }
      catch (Exception ex) { Serilog.Log.Warning(ex, "SMGo Supabase poll error"); }
      finally
      {
        System.Threading.Interlocked.Exchange(ref _pollInProgress, 0);
      }
    }

    private async Task MarkSupabaseApplied(string id, CollectionContext context)
    {
      try
      {
        var patch = new HttpRequestMessage(new HttpMethod("PATCH"),
          $"{_supaUrl}/rest/v1/smgo_queue?id=eq.{Uri.EscapeDataString(id)}&collection_id=eq.{Uri.EscapeDataString(context.Id)}");
        patch.Headers.Add("apikey", _supaKey);
        patch.Headers.Add("Authorization", $"Bearer {_supaKey}");
        patch.Headers.Add("Prefer", "return=minimal");
        patch.Content = new StringContent("{\"applied\":true}", Encoding.UTF8, "application/json");
        using var _ = await _http.SendAsync(patch);
      }
      catch { }
    }

    // ── Single-item apply helpers (shared between file-based and Supabase) ───

    private bool ApplyOneExtract(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var text     = p["text"]?.ToString() ?? "";
      var parentId = p["parentId"]?.Value<int>() ?? 0;
      if (string.IsNullOrEmpty(text)) return false;
      var html    = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(text)}</span>\n<span />";
      var builder = new ElementBuilder(ElementType.Topic, new TextContent(true, html))
        .WithParent(parentId).DoNotDisplay();
      if (!IsCurrent(context)) return false;
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.None, builder);
      return true;
    }

    private bool ApplyOneQA(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var question = p["question"]?.ToString() ?? "";
      var answer   = p["answer"]?.ToString() ?? "";
      var parentId = p["parentId"]?.Value<int>() ?? 0;
      if (string.IsNullOrWhiteSpace(question)) return false;
      var qHtml = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(question)}</span>";
      var aHtml = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(answer)}</span>";
      var qContent = new TextContent(true, qHtml);
      var aContent = new TextContent(true, aHtml) { DisplayAt = AtFlags.NonQuestion };
      var builder = new ElementBuilder(ElementType.Item, qContent, aContent)
        .WithParent(parentId).DoNotDisplay();
      if (!IsCurrent(context)) return false;
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.None, builder);
      return true;
    }

    private bool ApplyOneCloze(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var sentence = p["sentence"]?.ToString() ?? "";
      var parentId = p["parentId"]?.Value<int>() ?? 0;
      if (string.IsNullOrWhiteSpace(sentence)) return false;

      // Question side: replace [word] with [...] in blue
      var qBlanked = Regex.Replace(sentence, @"\[([^\]]+)\]",
        _ => "<span style=\"color:blue\">[...]</span>");
      var qHtml = $"<span style=\"color:#231F20\">{qBlanked}</span>";

      // Answer side: reveal blanked words in red — only shown after "Show Answer"
      var aBlanked = Regex.Replace(sentence, @"\[([^\]]+)\]",
        m => $"<span style=\"color:red\">{WebUtility.HtmlEncode(m.Groups[1].Value)}</span>");
      var aHtml = $"<span style=\"color:#231F20\">{aBlanked}</span>";

      var qContent = new TextContent(true, qHtml);
      var aContent = new TextContent(true, aHtml) { DisplayAt = AtFlags.NonQuestion };
      var builder  = new ElementBuilder(ElementType.Item, qContent, aContent)
        .WithParent(parentId).DoNotDisplay();
      if (!IsCurrent(context)) return false;
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.None, builder);
      return true;
    }

    // Creates a new extract Topic as a child of the PDF root element (not the pdf-extract child)
    private bool ApplyOnePdfExtract(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var parentId = p["parentId"]?.Value<int>() ?? 0;
      if (parentId <= 0) return false;

      // Mixed-content staged extract: segments[] array of {kind, text?, dataUrl?}
      if (p["segments"] is JArray segs && segs.Count > 0)
      {
        var sb = new StringBuilder();
        foreach (var seg in segs)
        {
          var kind = seg["kind"]?.ToString();
          if (kind == "text")
          {
            var t = seg["text"]?.ToString() ?? "";
            if (!string.IsNullOrEmpty(t))
              sb.Append($"<p style=\"color:#231F20\">{WebUtility.HtmlEncode(t)}</p>");
          }
          else if (kind == "image")
          {
            var dataUrl = seg["dataUrl"]?.ToString() ?? "";
            var imgPath = seg["imgPath"]?.ToString() ?? "";
            if (!string.IsNullOrEmpty(dataUrl))
              sb.Append($"<img src=\"{dataUrl}\" style=\"max-width:100%;height:auto\">");
            else if (!string.IsNullOrEmpty(imgPath))
            {
              var fileUri = "file:///" + imgPath.Replace('\\', '/');
              sb.Append($"<img src=\"{fileUri}\" style=\"max-width:100%;height:auto\">");
            }
          }
        }
        if (sb.Length == 0) return false;
        sb.Append("<span />");
        var builder = new ElementBuilder(ElementType.Topic, new TextContent(true, sb.ToString()))
          .WithParent(parentId).DoNotDisplay();
        if (!IsCurrent(context)) return false;
        Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.None, builder);
        return true;
      }

      // Simple text-only extract
      var text = p["text"]?.ToString() ?? "";
      if (string.IsNullOrEmpty(text)) return false;
      var html = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(text)}</span>\n<span />";
      var simpleBuilder = new ElementBuilder(ElementType.Topic, new TextContent(true, html))
        .WithParent(parentId).DoNotDisplay();
      if (!IsCurrent(context)) return false;
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.None, simpleBuilder);
      return true;
    }

    private bool ApplyOneImageExtract(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var parentId  = p["parentId"]?.Value<int>() ?? 0;
      var imageData = p["imageData"]?.ToString() ?? "";
      if (parentId <= 0 || string.IsNullOrEmpty(imageData)) return false;
      var html    = $"<img src=\"{imageData}\" style=\"max-width:100%;height:auto\"><span />";
      var builder = new ElementBuilder(ElementType.Topic, new TextContent(true, html))
        .WithParent(parentId).DoNotDisplay();
      if (!IsCurrent(context)) return false;
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.None, builder);
      return true;
    }

    private bool ApplyOneGrade(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var elementId = p["elementId"]?.Value<int>() ?? 0;
      var grade     = p["grade"]?.Value<int>() ?? -1;
      if (elementId <= 0 || grade < 0 || grade > 5) return false;
      if (!IsCurrent(context)) return false;
      Svc.SM.UI.ElementWdw.GoToElement(elementId);
      Thread.Sleep(400);
      if (!IsCurrent(context)) return false;
      Svc.SM.UI.ElementWdw.AssignGrade(grade);
      Thread.Sleep(200);
      return true;
    }

    private bool ApplyOneDismiss(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var elementId = p["elementId"]?.Value<int>() ?? 0;
      if (elementId <= 0) return false;
      // IElement.Done() calls the SM engine directly (bypasses the UI window),
      // so no confirmation dialog fires. This marks the element Dismissed and
      // removes it from the Outstanding queue permanently — equivalent to SM's Ignore.
      var element = Svc.SM.Registry.Element[elementId];
      if (element == null) return false;
      if (!IsCurrent(context)) return false;
      return element.Done();
    }

    private bool ApplyOnePriority(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var elementId = p["elementId"]?.Value<int>() ?? 0;
      var priority  = p["priority"]?.Value<double>() ?? -1;
      if (elementId <= 0 || priority < 0 || priority > 100) return false;

      // priority.sub is a flat array of 4-byte little-endian uint32 element IDs.
      // The position (index) of an element determines its priority rank:
      //   priority% = index / total × 100  (lower index = higher priority)
      // We reposition the element to the slot that matches the requested percentage.
      var subFile = Path.Combine(context.Root, "info", "priority.sub");
      if (!File.Exists(subFile)) return false;
      try
      {
        var bytes = File.ReadAllBytes(subFile);
        var count = bytes.Length / 4;
        var ids   = new List<int>(count);
        for (int i = 0; i < bytes.Length; i += 4)
          ids.Add((int)BitConverter.ToUInt32(bytes, i));

        if (!ids.Remove(elementId)) return false; // element not tracked in priority queue

        int targetIdx = (int)Math.Round(priority / 100.0 * ids.Count);
        targetIdx = Math.Max(0, Math.Min(ids.Count, targetIdx));
        ids.Insert(targetIdx, elementId);

        var outBytes = new byte[ids.Count * 4];
        for (int i = 0; i < ids.Count; i++)
          Array.Copy(BitConverter.GetBytes((uint)ids[i]), 0, outBytes, i * 4, 4);
        if (!IsCurrent(context)) return false;
        File.WriteAllBytes(subFile, outBytes);

        Serilog.Log.Information("SMGo priority: elem {Id} → {Pct}% (slot {Idx}/{Total})",
          elementId, priority, targetIdx, ids.Count);
        return true;
      }
      catch (Exception ex)
      {
        Serilog.Log.Warning(ex, "SMGo ApplyOnePriority failed for elem {Id}", elementId);
        return false;
      }
    }

    private bool ApplyOneEdit(JObject p, CollectionContext? context = null)
    {
      context ??= CaptureCollectionContext(); if (context == null || !IsCurrent(context)) return false;
      var parentId  = p["elementId"]?.Value<int>() ?? 0;
      var text      = p["text"]?.ToString() ?? "";
      var imageData = p["imageData"]?.ToString() ?? "";
      if (parentId <= 0 || (string.IsNullOrWhiteSpace(text) && string.IsNullOrWhiteSpace(imageData)))
        return false;

      var sb = new StringBuilder();
      if (!string.IsNullOrWhiteSpace(text))
        sb.Append($"<p style=\"color:#231F20\">{WebUtility.HtmlEncode(text)}</p>");
      if (!string.IsNullOrWhiteSpace(imageData))
        sb.Append($"<img src=\"{imageData}\" style=\"max-width:100%;height:auto\">");

      var builder = new ElementBuilder(ElementType.Topic, new TextContent(true, sb.ToString()))
        .WithParent(parentId).DoNotDisplay();
      if (!IsCurrent(context)) return false;
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.None, builder);
      return true;
    }

    // ── FileSystemWatcher ─────────────────────────────────────────────────

    private void StartFileWatchers()
    {
      if (!HasCollectionContext()) return;
      var gradesDir   = QueueDir("grades");
      var extractDir  = QueueDir("extracts");
      var itemsDir    = QueueDir("items");
      var dismissDir  = QueueDir("dismisses");
      Directory.CreateDirectory(gradesDir);
      Directory.CreateDirectory(extractDir);
      Directory.CreateDirectory(itemsDir);
      Directory.CreateDirectory(dismissDir);

      _gradesWatcher = MakeWatcher(gradesDir,   OnGradeFileChanged);
      _extractsWatcher = MakeWatcher(extractDir, OnExtractFileChanged);
      _itemsWatcher    = MakeWatcher(itemsDir,   OnItemFileChanged);
      _dismissesWatcher = MakeWatcher(dismissDir, OnDismissFileChanged);
    }

    private static FileSystemWatcher MakeWatcher(string dir, FileSystemEventHandler handler)
    {
      var w = new FileSystemWatcher(dir, "*.json")
      {
        NotifyFilter        = NotifyFilters.FileName | NotifyFilters.LastWrite,
        EnableRaisingEvents = true,
      };
      w.Created += handler;
      w.Changed += handler;
      return w;
    }

    private void StopFileWatchers()
    {
      StopWatcher(ref _gradesWatcher);
      StopWatcher(ref _extractsWatcher);
      StopWatcher(ref _itemsWatcher);
      StopWatcher(ref _dismissesWatcher);
    }

    private static void StopWatcher(ref FileSystemWatcher? w)
    {
      if (w == null) return;
      w.EnableRaisingEvents = false;
      w.Dispose();
      w = null;
    }

    private void Debounce(Action action)
    {
      _applyDebounce?.Dispose();
      _applyDebounce = new Timer(_ => { try { action(); } catch { } }, null, 1000, Timeout.Infinite);
    }

    private void OnGradeFileChanged(object sender, FileSystemEventArgs e)   => Debounce(ApplyPendingGrades);
    private void OnExtractFileChanged(object sender, FileSystemEventArgs e) => Debounce(ApplyPendingExtracts);
    private void OnItemFileChanged(object sender, FileSystemEventArgs e)    => Debounce(ApplyPendingItems);
    private void OnDismissFileChanged(object sender, FileSystemEventArgs e) => Debounce(ApplyPendingDismisses);

    // ── File-based apply (local server fallback) ──────────────────────────

    private void ApplyPendingGrades()
    {
      var context = CaptureCollectionContext();
      if (context == null) return;
      var dir = QueueDir("grades", context);
      if (!Directory.Exists(dir)) return;
      foreach (var file in Directory.GetFiles(dir, "*.json"))
      {
        try
        {
          var reviews = JsonConvert.DeserializeObject<List<GradeRecord>>(File.ReadAllText(file));
          if (reviews == null || reviews.Count == 0) continue;
          if (reviews.Exists(r => r.CollectionId != context.Id || r.ProtocolVersion != 2))
          { Serilog.Log.Warning("SMGo left grade file {File}: collection or protocol mismatch", file); continue; }
          while (reviews.Count > 0)
          {
            var r = reviews[0];
            var p = new JObject { ["elementId"] = r.ElementId, ["grade"] = r.Grade };
            bool applied;
            lock (_collectionGate)
              applied = IsCurrent(context) && ApplyOneGrade(p, context);
            if (!applied) break;
            reviews.RemoveAt(0);
            PersistRemaining(file, reviews);
            Thread.Sleep(200);
          }
          if (reviews.Count > 0) Serilog.Log.Warning("SMGo left grade file {File}: not fully applied", file);
        }
        catch { }
      }
    }

    private void ApplyPendingExtracts()
    {
      var context = CaptureCollectionContext();
      if (context == null) return;
      var dir = QueueDir("extracts", context);
      if (!Directory.Exists(dir)) return;
      foreach (var file in Directory.GetFiles(dir, "*.json"))
      {
        try
        {
          var extracts = JsonConvert.DeserializeObject<List<ExtractRecord>>(File.ReadAllText(file));
          if (extracts == null || extracts.Count == 0) continue;
          if (extracts.Exists(e => e.CollectionId != context.Id || e.ProtocolVersion != 2))
          { Serilog.Log.Warning("SMGo left extract file {File}: collection or protocol mismatch", file); continue; }
          while (extracts.Count > 0)
          {
            var e = extracts[0];
            var p = new JObject { ["text"] = e.Text, ["parentId"] = e.ParentId };
            bool applied;
            lock (_collectionGate)
              applied = IsCurrent(context) && ApplyOneExtract(p, context);
            if (!applied) break;
            extracts.RemoveAt(0);
            PersistRemaining(file, extracts);
            Thread.Sleep(300);
          }
          if (extracts.Count > 0) Serilog.Log.Warning("SMGo left extract file {File}: not fully applied", file);
        }
        catch { }
      }
    }

    private void ApplyPendingItems()
    {
      var context = CaptureCollectionContext();
      if (context == null) return;
      var dir = QueueDir("items", context);
      if (!Directory.Exists(dir)) return;
      foreach (var file in Directory.GetFiles(dir, "*.json"))
      {
        try
        {
          var items = JsonConvert.DeserializeObject<List<ItemRecord>>(File.ReadAllText(file));
          if (items == null || items.Count == 0) continue;
          if (items.Exists(i => i.CollectionId != context.Id || i.ProtocolVersion != 2))
          { Serilog.Log.Warning("SMGo left item file {File}: collection or protocol mismatch", file); continue; }
          while (items.Count > 0)
          {
            var item = items[0];
            var p = new JObject
            {
              ["type"] = item.Type, ["parentId"] = item.ParentId,
              ["question"] = item.Question, ["answer"] = item.Answer,
              ["sentence"] = item.Sentence,
            };
            bool applied;
            lock (_collectionGate)
            {
              applied = IsCurrent(context) &&
                (item.Type == "qa" ? ApplyOneQA(p, context) :
                 item.Type == "cloze" && ApplyOneCloze(p, context));
            }
            if (!applied) break;
            items.RemoveAt(0);
            PersistRemaining(file, items);
            Thread.Sleep(300);
          }
          if (items.Count > 0) Serilog.Log.Warning("SMGo left item file {File}: not fully applied", file);
        }
        catch { }
      }
    }

    // ── Dismiss application ───────────────────────────────────────────────

    private void ApplyPendingDismisses()
    {
      var context = CaptureCollectionContext();
      if (context == null) return;
      var dismissDir = QueueDir("dismisses", context);
      if (!Directory.Exists(dismissDir)) return;

      foreach (var file in Directory.GetFiles(dismissDir, "*.json"))
      {
        try
        {
          var records = JsonConvert.DeserializeObject<List<DismissRecord>>(File.ReadAllText(file));
          if (records == null || records.Count == 0) continue;
          if (records.Exists(r => r.CollectionId != context.Id || r.ProtocolVersion != 2))
          { Serilog.Log.Warning("SMGo left dismiss file {File}: collection or protocol mismatch", file); continue; }
          while (records.Count > 0)
          {
            var r = records[0];
            var p = new JObject { ["elementId"] = r.ElementId };
            bool applied;
            lock (_collectionGate)
              applied = IsCurrent(context) && ApplyOneDismiss(p, context);
            if (!applied) break;
            records.RemoveAt(0);
            PersistRemaining(file, records);
            Thread.Sleep(200);
          }
          if (records.Count > 0) Serilog.Log.Warning("SMGo left dismiss file {File}: not fully applied", file);
        }
        catch { }
      }
    }

    private static void MarkFileApplied(string file)
    {
      var dest = file.Replace(".json", ".applied.json");
      if (File.Exists(dest)) File.Delete(dest);
      File.Move(file, dest);
    }

    private static void PersistRemaining<T>(string file, List<T> records)
    {
      if (records.Count == 0) MarkFileApplied(file);
      else File.WriteAllText(file, JsonConvert.SerializeObject(records, Formatting.Indented));
    }

    // ── HTTP server ───────────────────────────────────────────────────────

    private void StartHttpServer()
    {
      try
      {
        _cts      = new CancellationTokenSource();
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://+:{Port}/");
        _listener.Start();

        _serverThread = new Thread(() => ServeLoop(_cts.Token))
        {
          IsBackground = true,
          Name         = "SMGo-HTTP",
        };
        _serverThread.Start();
        Serilog.Log.Information("SMGo HTTP server started on port {Port}", Port);
      }
      catch (Exception ex)
      {
        Serilog.Log.Error(ex, "SMGo HTTP server failed to start");
      }
    }

    private void StopHttpServer()
    {
      _cts?.Cancel();
      try { _listener?.Stop(); } catch { }
      _listener = null;
    }

    private void ServeLoop(CancellationToken ct)
    {
      while (!ct.IsCancellationRequested)
      {
        HttpListenerContext? ctx = null;
        try
        {
          ctx = _listener!.GetContext();
        }
        catch
        {
          break;
        }

        Task.Run(() => HandleRequest(ctx));
      }
    }

    private void HandleRequest(HttpListenerContext ctx)
    {
      var req = ctx.Request;
      var res = ctx.Response;

      // CORS pre-flight
      res.Headers.Add("Access-Control-Allow-Origin", "*");
      res.Headers.Add("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.Headers.Add("Access-Control-Allow-Headers", "Content-Type");
      res.Headers.Add("Cache-Control", "no-store");

      if (req.HttpMethod == "OPTIONS")
      {
        res.StatusCode = 204;
        res.Close();
        return;
      }

      var url = req.Url!.AbsolutePath;

      try
      {
        if (url == "/api/today" && req.HttpMethod == "GET")
        {
          ServeToday(res);
          return;
        }

        if (url == "/api/grades" && req.HttpMethod == "POST")
        {
          SaveGrades(req, res);
          return;
        }

        if (url == "/api/extracts" && req.HttpMethod == "POST")
        {
          SaveExtract(req, res);
          return;
        }

        if (url == "/api/extracts" && req.HttpMethod == "GET")
        {
          ServeExtracts(res);
          return;
        }

        if (url == "/api/pending-grades" && req.HttpMethod == "GET")
        {
          ServePendingGrades(res);
          return;
        }

        if (url == "/api/items" && req.HttpMethod == "POST")
        {
          SaveItem(req, res);
          return;
        }

        if (url == "/api/dismiss" && req.HttpMethod == "POST")
        {
          SaveDismiss(req, res);
          return;
        }

        // Serve a PDF file for a given extract element ID (LAN only)
        if (url.StartsWith("/api/pdf/") && req.HttpMethod == "GET")
        {
          if (int.TryParse(url.Substring("/api/pdf/".Length), out int pdfElemId))
            ServePdf(pdfElemId, res);
          else { res.StatusCode = 400; res.Close(); }
          return;
        }

        // Apply pending immediately (called by PWA on server wake)
        if (url == "/api/apply" && req.HttpMethod == "POST")
        {
          Task.Run(() =>
          {
            try { ApplyPendingGrades(); }    catch { }
            try { ApplyPendingExtracts(); }  catch { }
            try { ApplyPendingItems(); }     catch { }
            try { ApplyPendingDismisses(); } catch { }
          });
          SendJson(res, new { ok = true });
          return;
        }

        // Static file from docs/
        ServeStatic(req, res);
      }
      catch (Exception ex)
      {
        SendJson(res, new { error = ex.Message }, 500);
      }
    }

    // ── API handlers ──────────────────────────────────────────────────────

    private void ServeToday(HttpListenerResponse res)
    {
      if (!HasCollectionContext()) { SendJson(res, new { error = "No active SuperMemo collection." }, 503); return; }
      var dataFile = Path.Combine(DataDir, "docs", "data", "today.json");
      if (!File.Exists(dataFile))
      {
        SendJson(res, new { error = "No today.json. Run export.js first." }, 404);
        return;
      }
      var json = File.ReadAllText(dataFile);
      var data = JObject.Parse(json);
      if (!MatchesActiveCollection(data["collectionId"]?.ToString()))
      {
        SendJson(res, new { error = "today.json belongs to another collection. Export the active collection first." }, 409);
        return;
      }
      SendRaw(res, 200, "application/json", json);
    }

    private void SaveGrades(HttpListenerRequest req, HttpListenerResponse res)
    {
      var body    = ReadBody(req);
      var payload = JObject.Parse(body);
      if (!TryCaptureIncomingCollection(payload, res, out var context) || context == null) return;
      var dateStr = payload["date"]?.ToString() ?? DateTime.Now.ToString("yyyy-MM-dd");
      var dir     = QueueDir("grades", context);
      Directory.CreateDirectory(dir);
      var file = Path.Combine(dir, $"{dateStr}.json");

      var existing = new Dictionary<int, JObject>();
      if (File.Exists(file))
        foreach (var r in JArray.Parse(File.ReadAllText(file)))
        {
          var eid = r["elementId"]?.Value<int>() ?? 0;
          if (eid > 0) existing[eid] = (JObject)r;
        }

      var reviews = payload["reviews"] as JArray ?? new JArray();
      foreach (var r in reviews)
      {
        if (r is not JObject review
          || review["protocolVersion"]?.Value<int>() != 2
          || !string.Equals(review["collectionId"]?.ToString(), context.Id, StringComparison.Ordinal))
        { SendJson(res, new { error = "Grade record collection or protocol mismatch." }, 409); return; }
        ((JObject)r)["collectionId"] = context.Id;
        var eid = r["elementId"]?.Value<int>() ?? 0;
        if (eid > 0) existing[eid] = (JObject)r;
      }

      if (!IsCurrent(context)) { SendJson(res, new { error = "Active collection changed." }, 409); return; }
      File.WriteAllText(file, JsonConvert.SerializeObject(
        new JArray(existing.Values), Formatting.Indented));

      SendJson(res, new { saved = existing.Count });
    }

    private void SaveExtract(HttpListenerRequest req, HttpListenerResponse res)
    {
      var body    = ReadBody(req);
      var extract = JObject.Parse(body);
      if (!TryCaptureIncomingCollection(extract, res, out var context) || context == null) return;
      var date    = DateTime.Now.ToString("yyyy-MM-dd");
      var dir     = QueueDir("extracts", context);
      extract["collectionId"] = context.Id;
      Directory.CreateDirectory(dir);
      var file = Path.Combine(dir, $"{date}.json");

      var list = new JArray();
      if (File.Exists(file)) list = JArray.Parse(File.ReadAllText(file));

      var id = extract["id"]?.ToString();
      bool found = false;
      foreach (var e in list) if (e["id"]?.ToString() == id) { found = true; break; }
      if (!found) list.Add(extract);

      if (!IsCurrent(context)) { SendJson(res, new { error = "Active collection changed." }, 409); return; }
      File.WriteAllText(file, JsonConvert.SerializeObject(list, Formatting.Indented));
      SendJson(res, new { saved = list.Count });
    }

    private void SaveItem(HttpListenerRequest req, HttpListenerResponse res)
    {
      var body = ReadBody(req);
      var item = JObject.Parse(body);
      if (!TryCaptureIncomingCollection(item, res, out var context) || context == null) return;
      var date = DateTime.Now.ToString("yyyy-MM-dd");
      var dir  = QueueDir("items", context);
      item["collectionId"] = context.Id;
      Directory.CreateDirectory(dir);
      var file = Path.Combine(dir, $"{date}.json");

      var list = new JArray();
      if (File.Exists(file)) list = JArray.Parse(File.ReadAllText(file));

      var id = item["id"]?.ToString();
      bool found = false;
      foreach (var e in list) if (e["id"]?.ToString() == id) { found = true; break; }
      if (!found) list.Add(item);

      if (!IsCurrent(context)) { SendJson(res, new { error = "Active collection changed." }, 409); return; }
      File.WriteAllText(file, JsonConvert.SerializeObject(list, Formatting.Indented));
      SendJson(res, new { saved = list.Count });
    }

    private void SaveDismiss(HttpListenerRequest req, HttpListenerResponse res)
    {
      var body   = ReadBody(req);
      var record = JObject.Parse(body);
      if (!TryCaptureIncomingCollection(record, res, out var context) || context == null) return;
      var date   = DateTime.Now.ToString("yyyy-MM-dd");
      var dir    = QueueDir("dismisses", context);
      record["collectionId"] = context.Id;
      Directory.CreateDirectory(dir);
      var file = Path.Combine(dir, $"{date}.json");

      var list = new JArray();
      if (File.Exists(file)) list = JArray.Parse(File.ReadAllText(file));
      list.Add(record);

      if (!IsCurrent(context)) { SendJson(res, new { error = "Active collection changed." }, 409); return; }
      File.WriteAllText(file, JsonConvert.SerializeObject(list, Formatting.Indented));
      SendJson(res, new { saved = list.Count });
    }

    private void ServeExtracts(HttpListenerResponse res)
    {
      var dir  = QueueDir("extracts");
      var all  = new JArray();
      if (Directory.Exists(dir))
        foreach (var f in Directory.GetFiles(dir, "*.json"))
          try { foreach (var e in JArray.Parse(File.ReadAllText(f))) all.Add(e); } catch { }
      SendRaw(res, 200, "application/json", all.ToString());
    }

    private void ServePendingGrades(HttpListenerResponse res)
    {
      var dir    = QueueDir("grades");
      var result = new JArray();
      if (Directory.Exists(dir))
        foreach (var f in Directory.GetFiles(dir, "*.json"))
          try
          {
            var date = Path.GetFileNameWithoutExtension(f);
            result.Add(new JObject
            {
              ["date"]    = date,
              ["reviews"] = JArray.Parse(File.ReadAllText(f)),
            });
          }
          catch { }
      SendRaw(res, 200, "application/json", result.ToString());
    }

    // ── PDF serving (LAN fallback) ────────────────────────────────────────

    private string CollectionElemDir => Path.Combine(
      CaptureCollectionContext()?.Root ?? throw new InvalidOperationException("No active collection"), "elements");
    // Find the parent .pdf file for a pdf-extract element.
    // SM creates the parent PDF element first (ID=N), then children (N+1, N+2...) in the same dir bucket.
    private string? FindParentPdfPath(int extractId)
    {
      int dir = (extractId - 1) / 10;
      for (int candidate = extractId - 1; candidate >= 1; candidate--)
      {
        int cDir = (candidate - 1) / 10;
        if (cDir != dir) break;
        string folder = cDir > 0
          ? Path.Combine(CollectionElemDir, cDir.ToString())
          : CollectionElemDir;
        foreach (var ext in new[] { ".pdf", ".PDF" })
        {
          var p = Path.Combine(folder, candidate + ext);
          if (File.Exists(p)) return p;
        }
      }
      return null;
    }

    private void ServePdf(int extractId, HttpListenerResponse res)
    {
      var pdfPath = FindParentPdfPath(extractId);
      if (pdfPath == null || !File.Exists(pdfPath))
      {
        res.StatusCode = 404; res.Close(); return;
      }
      try
      {
        using var fs = File.OpenRead(pdfPath);
        res.StatusCode      = 200;
        res.ContentType     = "application/pdf";
        res.ContentLength64 = fs.Length;
        res.Headers["Access-Control-Allow-Origin"] = "*";
        fs.CopyTo(res.OutputStream);
        res.Close();
      }
      catch { try { res.StatusCode = 500; res.Close(); } catch { } }
    }

    private void ServeStatic(HttpListenerRequest req, HttpListenerResponse res)
    {
      var urlPath  = req.Url!.AbsolutePath == "/" ? "index.html" : req.Url.AbsolutePath.TrimStart('/');
      var docsRoot = Path.GetFullPath(Path.Combine(DataDir, "docs"));
      var filePath = Path.GetFullPath(Path.Combine(docsRoot, urlPath.Replace('/', Path.DirectorySeparatorChar)));

      // Reject path traversal attempts
      if (!filePath.StartsWith(docsRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
          && !filePath.Equals(docsRoot, StringComparison.OrdinalIgnoreCase))
      {
        res.StatusCode = 403; res.Close(); return;
      }

      if (!File.Exists(filePath))
      {
        res.StatusCode = 404;
        res.Close();
        return;
      }

      var ext  = Path.GetExtension(filePath).ToLowerInvariant();
      var mime = ext switch
      {
        ".html"        => "text/html; charset=utf-8",
        ".js"          => "application/javascript",
        ".css"         => "text/css",
        ".json"        => "application/json",
        ".png"         => "image/png",
        ".ico"         => "image/x-icon",
        ".webmanifest" => "application/manifest+json",
        _              => "application/octet-stream",
      };

      var bytes = File.ReadAllBytes(filePath);
      res.StatusCode  = 200;
      res.ContentType = mime;
      res.ContentLength64 = bytes.Length;
      res.OutputStream.Write(bytes, 0, bytes.Length);
      res.Close();
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────

    private static string ReadBody(HttpListenerRequest req)
    {
      using var sr = new StreamReader(req.InputStream, Encoding.UTF8);
      return sr.ReadToEnd();
    }

    private static void SendJson(HttpListenerResponse res, object data, int status = 200)
    {
      var json  = JsonConvert.SerializeObject(data);
      SendRaw(res, status, "application/json", json);
    }

    private static void SendRaw(HttpListenerResponse res, int status, string contentType, string body)
    {
      var bytes = Encoding.UTF8.GetBytes(body);
      res.StatusCode      = status;
      res.ContentType     = contentType;
      res.ContentLength64 = bytes.Length;
      try
      {
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
      }
      catch { }
    }
  }

  // ── Data models ──────────────────────────────────────────────────────────

  internal class GradeRecord
  {
    [JsonProperty("protocolVersion")] public int ProtocolVersion { get; set; }
    [JsonProperty("collectionId")] public string CollectionId { get; set; } = "";
    [JsonProperty("elementId")] public int    ElementId { get; set; }
    [JsonProperty("grade")]     public int    Grade     { get; set; }
    [JsonProperty("timestamp")] public string Timestamp { get; set; } = "";
  }

  internal class ExtractRecord
  {
    [JsonProperty("protocolVersion")] public int ProtocolVersion { get; set; }
    [JsonProperty("collectionId")] public string CollectionId { get; set; } = "";
    [JsonProperty("id")]          public string Id          { get; set; } = "";
    [JsonProperty("parentId")]    public int    ParentId    { get; set; }
    [JsonProperty("parentTitle")] public string ParentTitle { get; set; } = "";
    [JsonProperty("text")]        public string Text        { get; set; } = "";
    [JsonProperty("timestamp")]   public string Timestamp   { get; set; } = "";
  }

  internal class ItemRecord
  {
    [JsonProperty("protocolVersion")] public int ProtocolVersion { get; set; }
    [JsonProperty("collectionId")] public string CollectionId { get; set; } = "";
    [JsonProperty("id")]          public string Id          { get; set; } = "";
    [JsonProperty("type")]        public string Type        { get; set; } = ""; // "cloze" | "qa"
    [JsonProperty("parentId")]    public int    ParentId    { get; set; }
    [JsonProperty("parentTitle")] public string ParentTitle { get; set; } = "";
    [JsonProperty("sentence")]    public string Sentence    { get; set; } = ""; // cloze
    [JsonProperty("question")]    public string Question    { get; set; } = ""; // qa
    [JsonProperty("answer")]      public string Answer      { get; set; } = ""; // qa
    [JsonProperty("timestamp")]   public string Timestamp   { get; set; } = "";
  }

  internal class DismissRecord
  {
    [JsonProperty("protocolVersion")] public int ProtocolVersion { get; set; }
    [JsonProperty("collectionId")] public string CollectionId { get; set; } = "";
    [JsonProperty("elementId")] public int    ElementId { get; set; }
    [JsonProperty("timestamp")] public string Timestamp { get; set; } = "";
  }
}

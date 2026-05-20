using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
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

      // Export today's cards to Supabase after a short delay
      Task.Delay(5000).ContinueWith(_ => RunExportCloud());

      StartHttpServer();
      StartFileWatchers();
      StartSupabasePoller();
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

    private void RunExportCloud()
    {
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
      // Prevent a second poll from starting while the previous one is still processing
      if (System.Threading.Interlocked.Exchange(ref _pollInProgress, 1) == 1) return;
      try
      {
        var req = new HttpRequestMessage(HttpMethod.Get,
          $"{_supaUrl}/rest/v1/smgo_queue?applied=eq.false&order=id.asc");
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
          var payload = item["payload"] as JObject;
          if (payload == null || string.IsNullOrEmpty(id)) continue;

          bool applied = false;
          try
          {
            switch (type)
            {
              case "extract":             applied = ApplyOneExtract(payload);         break;
              case "pdf-extract-create":  applied = ApplyOnePdfExtract(payload);     break;
              case "image-extract":       applied = ApplyOneImageExtract(payload);   break;
              case "qa":                  applied = ApplyOneQA(payload);             break;
              case "cloze":               applied = ApplyOneCloze(payload);          break;
              case "grade":               applied = ApplyOneGrade(payload);          break;
              case "dismiss":             applied = ApplyOneDismiss(payload);        break;
              case "priority":            applied = ApplyOnePriority(payload);       break;
              case "edit":                applied = ApplyOneEdit(payload);           break;
            }
          }
          catch (Exception ex)
          {
            Serilog.Log.Warning(ex, "SMGo Supabase: failed to apply item {Id}", id);
          }

          // Grade, dismiss, priority: mark applied regardless of success — these
          // can silently fail (grade outside review session, element not in priority queue);
          // retrying forever creates an infinite loop and duplicates create-type items.
          bool shouldMark = applied || type == "grade" || type == "dismiss" || type == "priority";
          if (shouldMark) await MarkSupabaseApplied(id);
          await Task.Delay(600);
        }
      }
      catch (Exception ex) { Serilog.Log.Warning(ex, "SMGo Supabase poll error"); }
      finally
      {
        System.Threading.Interlocked.Exchange(ref _pollInProgress, 0);
      }
    }

    private async Task MarkSupabaseApplied(string id)
    {
      try
      {
        var patch = new HttpRequestMessage(new HttpMethod("PATCH"),
          $"{_supaUrl}/rest/v1/smgo_queue?id=eq.{Uri.EscapeDataString(id)}");
        patch.Headers.Add("apikey", _supaKey);
        patch.Headers.Add("Authorization", $"Bearer {_supaKey}");
        patch.Headers.Add("Prefer", "return=minimal");
        patch.Content = new StringContent("{\"applied\":true}", Encoding.UTF8, "application/json");
        using var _ = await _http.SendAsync(patch);
      }
      catch { }
    }

    // ── Single-item apply helpers (shared between file-based and Supabase) ───

    private bool ApplyOneExtract(JObject p)
    {
      var text     = p["text"]?.ToString() ?? "";
      var parentId = p["parentId"]?.Value<int>() ?? 0;
      if (string.IsNullOrEmpty(text)) return false;
      var html    = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(text)}</span>\n<span />";
      var builder = new ElementBuilder(ElementType.Topic, new TextContent(true, html))
        .WithParent(parentId).DoNotDisplay();
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.CreateSubfolders, builder);
      return true;
    }

    private bool ApplyOneQA(JObject p)
    {
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
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.CreateSubfolders, builder);
      return true;
    }

    private bool ApplyOneCloze(JObject p)
    {
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
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.CreateSubfolders, builder);
      return true;
    }

    // Creates a new extract Topic as a child of the PDF root element (not the pdf-extract child)
    private bool ApplyOnePdfExtract(JObject p)
    {
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
            if (!string.IsNullOrEmpty(dataUrl))
              sb.Append($"<img src=\"{dataUrl}\" style=\"max-width:100%;height:auto\">");
          }
        }
        if (sb.Length == 0) return false;
        sb.Append("<span />");
        var builder = new ElementBuilder(ElementType.Topic, new TextContent(true, sb.ToString()))
          .WithParent(parentId).DoNotDisplay();
        Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.CreateSubfolders, builder);
        return true;
      }

      // Simple text-only extract
      var text = p["text"]?.ToString() ?? "";
      if (string.IsNullOrEmpty(text)) return false;
      var html = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(text)}</span>\n<span />";
      var simpleBuilder = new ElementBuilder(ElementType.Topic, new TextContent(true, html))
        .WithParent(parentId).DoNotDisplay();
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.CreateSubfolders, simpleBuilder);
      return true;
    }

    private bool ApplyOneImageExtract(JObject p)
    {
      var parentId  = p["parentId"]?.Value<int>() ?? 0;
      var imageData = p["imageData"]?.ToString() ?? "";
      if (parentId <= 0 || string.IsNullOrEmpty(imageData)) return false;
      var html    = $"<img src=\"{imageData}\" style=\"max-width:100%;height:auto\"><span />";
      var builder = new ElementBuilder(ElementType.Topic, new TextContent(true, html))
        .WithParent(parentId).DoNotDisplay();
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.CreateSubfolders, builder);
      return true;
    }

    private bool ApplyOneGrade(JObject p)
    {
      var elementId = p["elementId"]?.Value<int>() ?? 0;
      var grade     = p["grade"]?.Value<int>() ?? -1;
      if (elementId <= 0 || grade < 0 || grade > 5) return false;
      Svc.SM.UI.ElementWdw.GoToElement(elementId);
      Thread.Sleep(400);
      Svc.SM.UI.ElementWdw.AssignGrade(grade);
      Thread.Sleep(200);
      return true;
    }

    private bool ApplyOneDismiss(JObject p)
    {
      var elementId = p["elementId"]?.Value<int>() ?? 0;
      if (elementId <= 0) return false;
      // IElement.Done() calls the SM engine directly (bypasses the UI window),
      // so no confirmation dialog fires. This marks the element Dismissed and
      // removes it from the Outstanding queue permanently — equivalent to SM's Ignore.
      var element = Svc.SM.Registry.Element[elementId];
      if (element == null) return false;
      return element.Done();
    }

    private bool ApplyOnePriority(JObject p)
    {
      var elementId = p["elementId"]?.Value<int>() ?? 0;
      var priority  = p["priority"]?.Value<double>() ?? -1;
      if (elementId <= 0 || priority < 0 || priority > 100) return false;

      // priority.sub is a flat array of 4-byte little-endian uint32 element IDs.
      // The position (index) of an element determines its priority rank:
      //   priority% = index / total × 100  (lower index = higher priority)
      // We reposition the element to the slot that matches the requested percentage.
      var subFile = Path.Combine(CollectionInfoDir, "priority.sub");
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

    private bool ApplyOneEdit(JObject p)
    {
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
      Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.CreateSubfolders, builder);
      return true;
    }

    // ── FileSystemWatcher ─────────────────────────────────────────────────

    private void StartFileWatchers()
    {
      var gradesDir   = Path.Combine(DataDir, "grades");
      var extractDir  = Path.Combine(DataDir, "extracts");
      var itemsDir    = Path.Combine(DataDir, "items");
      var dismissDir  = Path.Combine(DataDir, "dismisses");
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
      var dir = Path.Combine(DataDir, "grades");
      if (!Directory.Exists(dir)) return;
      foreach (var file in Directory.GetFiles(dir, "*.json"))
      {
        try
        {
          var reviews = JsonConvert.DeserializeObject<List<GradeRecord>>(File.ReadAllText(file));
          if (reviews == null || reviews.Count == 0) continue;
          foreach (var r in reviews)
          {
            var p = new JObject { ["elementId"] = r.ElementId, ["grade"] = r.Grade };
            ApplyOneGrade(p);
            Thread.Sleep(200);
          }
          MarkFileApplied(file);
        }
        catch { }
      }
    }

    private void ApplyPendingExtracts()
    {
      var dir = Path.Combine(DataDir, "extracts");
      if (!Directory.Exists(dir)) return;
      foreach (var file in Directory.GetFiles(dir, "*.json"))
      {
        try
        {
          var extracts = JsonConvert.DeserializeObject<List<ExtractRecord>>(File.ReadAllText(file));
          if (extracts == null || extracts.Count == 0) continue;
          foreach (var e in extracts)
          {
            var p = new JObject { ["text"] = e.Text, ["parentId"] = e.ParentId };
            ApplyOneExtract(p);
            Thread.Sleep(300);
          }
          MarkFileApplied(file);
        }
        catch { }
      }
    }

    private void ApplyPendingItems()
    {
      var dir = Path.Combine(DataDir, "items");
      if (!Directory.Exists(dir)) return;
      foreach (var file in Directory.GetFiles(dir, "*.json"))
      {
        try
        {
          var items = JsonConvert.DeserializeObject<List<ItemRecord>>(File.ReadAllText(file));
          if (items == null || items.Count == 0) continue;
          foreach (var item in items)
          {
            var p = new JObject
            {
              ["type"] = item.Type, ["parentId"] = item.ParentId,
              ["question"] = item.Question, ["answer"] = item.Answer,
              ["sentence"] = item.Sentence,
            };
            if (item.Type == "qa")    ApplyOneQA(p);
            if (item.Type == "cloze") ApplyOneCloze(p);
            Thread.Sleep(300);
          }
          MarkFileApplied(file);
        }
        catch { }
      }
    }

    // ── Dismiss application ───────────────────────────────────────────────

    private void ApplyPendingDismisses()
    {
      var dismissDir = Path.Combine(DataDir, "dismisses");
      if (!Directory.Exists(dismissDir)) return;

      foreach (var file in Directory.GetFiles(dismissDir, "*.json"))
      {
        try
        {
          var records = JsonConvert.DeserializeObject<List<DismissRecord>>(File.ReadAllText(file));
          if (records == null || records.Count == 0) continue;

          foreach (var r in records)
          {
            Svc.SM.UI.ElementWdw.GoToElement(r.ElementId);
            Thread.Sleep(400);
            Svc.SM.UI.ElementWdw.Done();
            Thread.Sleep(200);
          }

          var dest = file.Replace(".json", ".applied.json");
          if (File.Exists(dest)) File.Delete(dest);
          File.Move(file, dest);
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
      var dataFile = Path.Combine(DataDir, "docs", "data", "today.json");
      if (!File.Exists(dataFile))
      {
        SendJson(res, new { error = "No today.json. Run export.js first." }, 404);
        return;
      }
      var json = File.ReadAllText(dataFile);
      SendRaw(res, 200, "application/json", json);
    }

    private void SaveGrades(HttpListenerRequest req, HttpListenerResponse res)
    {
      var body    = ReadBody(req);
      var payload = JObject.Parse(body);
      var dateStr = payload["date"]?.ToString() ?? DateTime.Now.ToString("yyyy-MM-dd");
      var dir     = Path.Combine(DataDir, "grades");
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
        var eid = r["elementId"]?.Value<int>() ?? 0;
        if (eid > 0) existing[eid] = (JObject)r;
      }

      File.WriteAllText(file, JsonConvert.SerializeObject(
        new JArray(existing.Values), Formatting.Indented));

      SendJson(res, new { saved = existing.Count });
    }

    private void SaveExtract(HttpListenerRequest req, HttpListenerResponse res)
    {
      var body    = ReadBody(req);
      var extract = JObject.Parse(body);
      var date    = DateTime.Now.ToString("yyyy-MM-dd");
      var dir     = Path.Combine(DataDir, "extracts");
      Directory.CreateDirectory(dir);
      var file = Path.Combine(dir, $"{date}.json");

      var list = new JArray();
      if (File.Exists(file)) list = JArray.Parse(File.ReadAllText(file));

      var id = extract["id"]?.ToString();
      bool found = false;
      foreach (var e in list) if (e["id"]?.ToString() == id) { found = true; break; }
      if (!found) list.Add(extract);

      File.WriteAllText(file, JsonConvert.SerializeObject(list, Formatting.Indented));
      SendJson(res, new { saved = list.Count });
    }

    private void SaveItem(HttpListenerRequest req, HttpListenerResponse res)
    {
      var body = ReadBody(req);
      var item = JObject.Parse(body);
      var date = DateTime.Now.ToString("yyyy-MM-dd");
      var dir  = Path.Combine(DataDir, "items");
      Directory.CreateDirectory(dir);
      var file = Path.Combine(dir, $"{date}.json");

      var list = new JArray();
      if (File.Exists(file)) list = JArray.Parse(File.ReadAllText(file));

      var id = item["id"]?.ToString();
      bool found = false;
      foreach (var e in list) if (e["id"]?.ToString() == id) { found = true; break; }
      if (!found) list.Add(item);

      File.WriteAllText(file, JsonConvert.SerializeObject(list, Formatting.Indented));
      SendJson(res, new { saved = list.Count });
    }

    private void SaveDismiss(HttpListenerRequest req, HttpListenerResponse res)
    {
      var body   = ReadBody(req);
      var record = JObject.Parse(body);
      var date   = DateTime.Now.ToString("yyyy-MM-dd");
      var dir    = Path.Combine(DataDir, "dismisses");
      Directory.CreateDirectory(dir);
      var file = Path.Combine(dir, $"{date}.json");

      var list = new JArray();
      if (File.Exists(file)) list = JArray.Parse(File.ReadAllText(file));
      list.Add(record);

      File.WriteAllText(file, JsonConvert.SerializeObject(list, Formatting.Indented));
      SendJson(res, new { saved = list.Count });
    }

    private void ServeExtracts(HttpListenerResponse res)
    {
      var dir  = Path.Combine(DataDir, "extracts");
      var all  = new JArray();
      if (Directory.Exists(dir))
        foreach (var f in Directory.GetFiles(dir, "*.json"))
          try { foreach (var e in JArray.Parse(File.ReadAllText(f))) all.Add(e); } catch { }
      SendRaw(res, 200, "application/json", all.ToString());
    }

    private void ServePendingGrades(HttpListenerResponse res)
    {
      var dir    = Path.Combine(DataDir, "grades");
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

    private const string CollectionElemDir = @"C:\SuperMemo\systems\Facharzt\elements";
    private const string CollectionInfoDir = @"C:\SuperMemo\systems\Facharzt\info";

    // Find the parent .pdf file for a pdf-extract element.
    // SM creates the parent PDF element first (ID=N), then children (N+1, N+2...) in the same dir bucket.
    private static string? FindParentPdfPath(int extractId)
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
    [JsonProperty("elementId")] public int    ElementId { get; set; }
    [JsonProperty("grade")]     public int    Grade     { get; set; }
    [JsonProperty("timestamp")] public string Timestamp { get; set; } = "";
  }

  internal class ExtractRecord
  {
    [JsonProperty("id")]          public string Id          { get; set; } = "";
    [JsonProperty("parentId")]    public int    ParentId    { get; set; }
    [JsonProperty("parentTitle")] public string ParentTitle { get; set; } = "";
    [JsonProperty("text")]        public string Text        { get; set; } = "";
    [JsonProperty("timestamp")]   public string Timestamp   { get; set; } = "";
  }

  internal class ItemRecord
  {
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
    [JsonProperty("elementId")] public int    ElementId { get; set; }
    [JsonProperty("timestamp")] public string Timestamp { get; set; } = "";
  }
}

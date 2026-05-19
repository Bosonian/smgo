using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
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

    // ── SMA lifecycle ─────────────────────────────────────────────────────

    protected override void OnSMStarted(bool wasSMAlreadyStarted)
    {
      base.OnSMStarted(wasSMAlreadyStarted);
      Serilog.Log.Information("SMGo OnSMStarted (wasSMAlreadyStarted={Already})", wasSMAlreadyStarted);

      // Give SM 2 seconds to fully settle before touching element window
      Task.Delay(2000).ContinueWith(_ =>
      {
        try { ApplyPendingGrades(); }    catch { }
        try { ApplyPendingExtracts(); }  catch { }
        try { ApplyPendingItems(); }     catch { }
        try { ApplyPendingDismisses(); } catch { }
      });

      StartHttpServer();
      StartFileWatchers();
    }

    protected override void OnSMStopped()
    {
      base.OnSMStopped();
      StopHttpServer();
      StopFileWatchers();
    }

    protected override void Dispose(bool disposing)
    {
      if (disposing)
      {
        StopHttpServer();
        StopFileWatchers();
        _applyDebounce?.Dispose();
      }
      base.Dispose(disposing);
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

    // ── Grade application ─────────────────────────────────────────────────

    private void ApplyPendingGrades()
    {
      var gradesDir = Path.Combine(DataDir, "grades");
      if (!Directory.Exists(gradesDir)) return;

      foreach (var file in Directory.GetFiles(gradesDir, "*.json"))
      {
        try
        {
          var reviews = JsonConvert.DeserializeObject<List<GradeRecord>>(File.ReadAllText(file));
          if (reviews == null || reviews.Count == 0) continue;

          foreach (var r in reviews)
          {
            if (r.Grade < 0 || r.Grade > 5) continue;
            Svc.SM.UI.ElementWdw.GoToElement(r.ElementId);
            Thread.Sleep(400);
            Svc.SM.UI.ElementWdw.AssignGrade(r.Grade);
            Thread.Sleep(200);
          }

          var dest = file.Replace(".json", ".applied.json");
          if (File.Exists(dest)) File.Delete(dest);
          File.Move(file, dest);
        }
        catch { }
      }
    }

    // ── Extract application ───────────────────────────────────────────────

    private void ApplyPendingExtracts()
    {
      var extractDir = Path.Combine(DataDir, "extracts");
      if (!Directory.Exists(extractDir)) return;

      foreach (var file in Directory.GetFiles(extractDir, "*.json"))
      {
        try
        {
          var extracts = JsonConvert.DeserializeObject<List<ExtractRecord>>(File.ReadAllText(file));
          if (extracts == null || extracts.Count == 0) continue;

          foreach (var e in extracts)
          {
            var html = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(e.Text)}</span>\n<span />";
            var builder = new ElementBuilder(ElementType.Topic, new TextContent(true, html))
              .WithParent(e.ParentId)
              .DoNotDisplay();

            Svc.SM.Registry.Element.Add(
              out _,
              ElemCreationFlags.CreateSubfolders,
              builder);

            Thread.Sleep(300);
          }

          var dest = file.Replace(".json", ".applied.json");
          if (File.Exists(dest)) File.Delete(dest);
          File.Move(file, dest);
        }
        catch { }
      }
    }

    // ── Item application (cloze + Q&A) ───────────────────────────────────

    private void ApplyPendingItems()
    {
      var itemsDir = Path.Combine(DataDir, "items");
      if (!Directory.Exists(itemsDir)) return;

      foreach (var file in Directory.GetFiles(itemsDir, "*.json"))
      {
        try
        {
          var items = JsonConvert.DeserializeObject<List<ItemRecord>>(File.ReadAllText(file));
          if (items == null || items.Count == 0) continue;

          foreach (var item in items)
          {
            ElementBuilder? builder = null;

            if (item.Type == "qa" && !string.IsNullOrWhiteSpace(item.Question))
            {
              var qHtml = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(item.Question)}</span>";
              var aHtml = $"<span style=\"color:#231F20\">{WebUtility.HtmlEncode(item.Answer)}</span>";
              builder = new ElementBuilder(ElementType.Item,
                new TextContent(true, qHtml),
                new TextContent(true, aHtml))
                .WithParent(item.ParentId).DoNotDisplay();
            }
            else if (item.Type == "cloze" && !string.IsNullOrWhiteSpace(item.Sentence))
            {
              // [word] → SM cloze blank
              var blanked = Regex.Replace(item.Sentence, @"\[([^\]]+)\]",
                m => $"<span style=\"color:blue\">[...]</span>");
              var html = $"<span style=\"color:#231F20\">{blanked}</span>";
              builder = new ElementBuilder(ElementType.Item, new TextContent(true, html))
                .WithParent(item.ParentId).DoNotDisplay();
            }

            if (builder == null) continue;

            Svc.SM.Registry.Element.Add(out _, ElemCreationFlags.CreateSubfolders, builder);
            Thread.Sleep(300);
          }

          var dest = file.Replace(".json", ".applied.json");
          if (File.Exists(dest)) File.Delete(dest);
          File.Move(file, dest);
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
          existing[(int)r["elementId"]!] = (JObject)r;

      foreach (var r in (JArray)(payload["reviews"] ?? new JArray()))
        existing[(int)r["elementId"]!] = (JObject)r;

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

    private void ServeStatic(HttpListenerRequest req, HttpListenerResponse res)
    {
      var urlPath  = req.Url!.AbsolutePath == "/" ? "index.html" : req.Url.AbsolutePath.TrimStart('/');
      var filePath = Path.Combine(DataDir, "docs", urlPath.Replace('/', Path.DirectorySeparatorChar));

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
      using var sr = new StreamReader(req.InputStream, req.ContentEncoding);
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

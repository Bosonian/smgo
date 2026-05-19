using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Diagnostics;
using System.Threading;

// ── Win32 API ─────────────────────────────────────────────────────────────
static class Win32
{
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string? cls, string? title);
    [DllImport("user32.dll")] public static extern bool  SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool  ShowWindow(IntPtr hWnd, int nCmd);
    [DllImport("user32.dll")] public static extern uint  SendInput(uint n, INPUT[] inputs, int cb);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool  PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    // Menu enumeration
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int    GetMenuItemCount(IntPtr hMenu);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr hMenu, int pos);
    [DllImport("user32.dll")] public static extern uint   GetMenuItemID(IntPtr hMenu, int pos);
    [DllImport("user32.dll", CharSet=CharSet.Auto)]
    public static extern int GetMenuString(IntPtr hMenu, uint id, StringBuilder buf, int max, uint flags);

    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Explicit)]   public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT
    { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public nint dwExtraInfo; }

    public const uint  INPUT_KEYBOARD  = 1;
    public const uint  KEYEVENTF_KEYUP = 2;
    public const int   SW_RESTORE      = 9;
    public const uint  WM_COMMAND      = 0x0111;
    public const uint  MF_BYPOSITION   = 0x0400;

    public const ushort VK_RETURN  = 0x0D;
    public const ushort VK_CONTROL = 0x11;
    public const ushort VK_MENU    = 0x12; // Alt
    public const ushort VK_BACK    = 0x08;
    public const ushort VK_J       = 0x4A;
    public const ushort VK_G       = 0x47;
    public const ushort VK_N       = 0x4E;
    public const ushort VK_V       = 0x56;
    public static readonly ushort[] VK_DIGITS = [0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39];

    public static void KeyDown(ushort vk) => SendInput(1,
        [new INPUT { type=INPUT_KEYBOARD, u=new INPUTUNION{ki=new KEYBDINPUT{wVk=vk}} }],
        Marshal.SizeOf<INPUT>());
    public static void KeyUp(ushort vk) => SendInput(1,
        [new INPUT { type=INPUT_KEYBOARD, u=new INPUTUNION{ki=new KEYBDINPUT{wVk=vk,dwFlags=KEYEVENTF_KEYUP}} }],
        Marshal.SizeOf<INPUT>());
    public static void KeyPress(ushort vk) { KeyDown(vk); Thread.Sleep(50); KeyUp(vk); Thread.Sleep(60); }
    public static void KeyChord(ushort mod, ushort vk)
    { KeyDown(mod); KeyDown(vk); Thread.Sleep(50); KeyUp(vk); KeyUp(mod); Thread.Sleep(120); }

    public static void TypeString(string s)
    {
        foreach (char c in s)
        {
            var inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki = new KEYBDINPUT { wVk=0, wScan=c, dwFlags=4 };
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].u.ki = new KEYBDINPUT { wVk=0, wScan=c, dwFlags=4|KEYEVENTF_KEYUP };
            SendInput(2, inputs, Marshal.SizeOf<INPUT>());
            Thread.Sleep(30);
        }
    }

    // Search SM's live menu tree for an item matching any keyword.
    // Returns the WM_COMMAND id, or 0 if not found.
    public static uint FindMenuCommand(IntPtr hWnd, params string[] keywords)
    {
        IntPtr hMenu = GetMenu(hWnd);
        if (hMenu == IntPtr.Zero) return 0;
        return SearchMenu(hMenu, keywords, depth: 0);
    }

    static uint SearchMenu(IntPtr hMenu, string[] keywords, int depth)
    {
        if (depth > 4) return 0;
        int count = GetMenuItemCount(hMenu);
        for (int i = 0; i < count; i++)
        {
            var sb = new StringBuilder(256);
            GetMenuString(hMenu, (uint)i, sb, 256, MF_BYPOSITION);
            string text = sb.ToString().Replace("&", "");

            // Check sub-menus first (recurse)
            IntPtr sub = GetSubMenu(hMenu, i);
            if (sub != IntPtr.Zero)
            {
                uint found = SearchMenu(sub, keywords, depth + 1);
                if (found != 0) return found;
            }
            else
            {
                uint id = GetMenuItemID(hMenu, i);
                if (id == 0 || id == 0xFFFF_FFFF) continue;
                if (keywords.Any(k => text.Contains(k, StringComparison.OrdinalIgnoreCase)))
                    return id;
            }
        }
        return 0;
    }
}

// ── Data models ────────────────────────────────────────────────────────────
record GradeRecord(
    [property: JsonPropertyName("elementId")] int    ElementId,
    [property: JsonPropertyName("grade")]     int    Grade,
    [property: JsonPropertyName("timestamp")] string Timestamp);

record ExtractRecord(
    [property: JsonPropertyName("id")]          string Id,
    [property: JsonPropertyName("parentId")]    int    ParentId,
    [property: JsonPropertyName("parentTitle")] string ParentTitle,
    [property: JsonPropertyName("text")]        string Text,
    [property: JsonPropertyName("timestamp")]   string Timestamp);

// ── Main ──────────────────────────────────────────────────────────────────
static class Program
{
    static int Main(string[] args)
    {
        bool extractMode = args.Contains("--extracts");
        string dataDir = extractMode
            ? (args.FirstOrDefault(a => !a.StartsWith('-'))
               ?? Path.Combine(AppContext.BaseDirectory, "..", "extracts"))
            : (args.Length > 0 ? args[0]
               : Path.Combine(AppContext.BaseDirectory, "..", "grades"));
        dataDir = Path.GetFullPath(dataDir);

        Console.WriteLine(extractMode
            ? "\n── SMGo Extract Applicator ─────────────────"
            : "\n── SMGo Grade Applicator ───────────────────");
        Console.WriteLine($"Data dir: {dataDir}");

        if (!Directory.Exists(dataDir)) { Console.WriteLine($"Directory not found: {dataDir}"); return 1; }

        var smHwnd = FindSMWindow();
        if (smHwnd == IntPtr.Zero)
        {
            Console.WriteLine("SuperMemo not found. Open SuperMemo first, then press Enter…");
            Console.ReadLine();
            smHwnd = FindSMWindow();
            if (smHwnd == IntPtr.Zero) { Console.WriteLine("Still not found. Exiting."); return 1; }
        }
        Console.WriteLine("SuperMemo found.");

        return extractMode
            ? RunExtracts(smHwnd, dataDir)
            : RunGrades(smHwnd, dataDir);
    }

    // ── Grade application ──────────────────────────────────────────────────
    static int RunGrades(IntPtr smHwnd, string gradesDir)
    {
        var files = Directory.GetFiles(gradesDir, "*.json").OrderBy(f => f).ToArray();
        if (files.Length == 0) { Console.WriteLine("No pending grade files."); return 0; }

        int total = 0;
        foreach (var file in files)
        {
            var date    = Path.GetFileNameWithoutExtension(file);
            var reviews = JsonSerializer.Deserialize<List<GradeRecord>>(File.ReadAllText(file));
            if (reviews is null || reviews.Count == 0) continue;

            Console.WriteLine($"\n── {date}: {reviews.Count} grades ──");
            foreach (var r in reviews)
            {
                Console.Write($"  Element {r.ElementId,4}  grade={r.Grade}  … ");
                ApplyGrade(smHwnd, r.ElementId, r.Grade);
                Console.WriteLine("OK");
                total++;
            }
            File.Move(file, file.Replace(".json", ".applied.json"), overwrite: true);
        }
        Console.WriteLine($"\n✓ Applied {total} grades.");
        return 0;
    }

    static void ApplyGrade(IntPtr smHwnd, int elementId, int grade)
    {
        if (grade < 0 || grade > 5) return;
        Win32.ShowWindow(smHwnd, Win32.SW_RESTORE);
        Win32.SetForegroundWindow(smHwnd);
        Thread.Sleep(300);
        Win32.KeyChord(Win32.VK_CONTROL, Win32.VK_J);
        Thread.Sleep(400);
        for (int i = 0; i < 8; i++) Win32.KeyPress(Win32.VK_BACK);
        Win32.TypeString(elementId.ToString());
        Thread.Sleep(100);
        Win32.KeyPress(Win32.VK_RETURN);
        Thread.Sleep(600);
        Win32.KeyChord(Win32.VK_CONTROL, Win32.VK_G);
        Thread.Sleep(300);
        Win32.KeyPress(Win32.VK_DIGITS[grade]);
        Thread.Sleep(200);
    }

    // ── Extract application ────────────────────────────────────────────────
    static int RunExtracts(IntPtr smHwnd, string extractDir)
    {
        var files = Directory.GetFiles(extractDir, "*.json").OrderBy(f => f).ToArray();
        if (files.Length == 0) { Console.WriteLine("No pending extract files."); return 0; }

        // Find SM's "Add child" menu command once — enumerate live menus
        Console.Write("Scanning SM menus for 'Add child'… ");
        uint addChildCmd = Win32.FindMenuCommand(smHwnd,
            "child", "Child", "Add child", "Insert child", "new child");
        if (addChildCmd != 0)
            Console.WriteLine($"found (cmd={addChildCmd})");
        else
            Console.WriteLine("not found — will use Ctrl+Alt+N fallback");

        int total = 0;
        foreach (var file in files)
        {
            var extracts = JsonSerializer.Deserialize<List<ExtractRecord>>(File.ReadAllText(file));
            if (extracts is null || extracts.Count == 0) continue;

            Console.WriteLine($"\n── {Path.GetFileNameWithoutExtension(file)}: {extracts.Count} extracts ──");
            foreach (var e in extracts)
            {
                string preview = e.Text.Length > 40 ? e.Text[..40] + "..." : e.Text;
                Console.Write($"  Parent {e.ParentId,4}  \"{preview}\"  ... ");
                bool ok = ApplyExtract(smHwnd, e.ParentId, e.Text, addChildCmd);
                Console.WriteLine(ok ? "OK" : "SKIP");
                if (ok) total++;
                Thread.Sleep(400);
            }
            File.Move(file, file.Replace(".json", ".applied.json"), overwrite: true);
        }
        Console.WriteLine($"\n✓ Created {total} extract elements in SM.");
        return 0;
    }

    static bool ApplyExtract(IntPtr smHwnd, int parentId, string text, uint addChildCmd)
    {
        // 1. Navigate to parent element
        Win32.ShowWindow(smHwnd, Win32.SW_RESTORE);
        Win32.SetForegroundWindow(smHwnd);
        Thread.Sleep(300);

        Win32.KeyChord(Win32.VK_CONTROL, Win32.VK_J);
        Thread.Sleep(400);
        for (int i = 0; i < 8; i++) Win32.KeyPress(Win32.VK_BACK);
        Win32.TypeString(parentId.ToString());
        Thread.Sleep(100);
        Win32.KeyPress(Win32.VK_RETURN);
        Thread.Sleep(800);

        // 2. Put extract text in clipboard (SM-compatible span HTML)
        string html = $"<span style=\"color:#231F20\">{System.Net.WebUtility.HtmlEncode(text)}</span>\n<span />";
        SetClipboard(html, text);
        Thread.Sleep(150);

        // 3. Create child element
        if (addChildCmd != 0)
        {
            // Use SM's own menu command — most reliable
            Win32.PostMessage(smHwnd, Win32.WM_COMMAND, (IntPtr)addChildCmd, IntPtr.Zero);
        }
        else
        {
            // Fallback: Ctrl+Alt+N (creates new element at current tree position in SM18)
            Win32.KeyDown(Win32.VK_CONTROL);
            Win32.KeyDown(Win32.VK_MENU);
            Win32.KeyPress(Win32.VK_N);
            Win32.KeyUp(Win32.VK_MENU);
            Win32.KeyUp(Win32.VK_CONTROL);
        }
        Thread.Sleep(700);

        // 4. Paste text into the new element's body
        Win32.SetForegroundWindow(smHwnd);
        Thread.Sleep(200);
        Win32.KeyChord(Win32.VK_CONTROL, Win32.VK_V);
        Thread.Sleep(300);
        Win32.KeyPress(Win32.VK_RETURN);
        Thread.Sleep(200);

        return true;
    }

    // Set both plain-text and HTML clipboard formats on STA thread
    static void SetClipboard(string html, string plain)
    {
        var t = new Thread(() => {
            System.Windows.Forms.Clipboard.SetDataObject(
                new System.Windows.Forms.DataObject(
                    System.Windows.Forms.DataFormats.Html,
                    WrapCfHtml(html)), true);
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start(); t.Join();
    }

    // Wrap HTML in the CF_HTML clipboard header format Windows requires
    static string WrapCfHtml(string fragment)
    {
        const string header =
            "Version:0.9\r\n" +
            "StartHTML:0000000105\r\n" +
            "EndHTML:{0:D10}\r\n" +
            "StartFragment:0000000141\r\n" +
            "EndFragment:{1:D10}\r\n";
        string pre  = "<html><body><!--StartFragment-->";
        string post = "<!--EndFragment--></body></html>";
        string body = pre + fragment + post;
        int endFrag = 105 + pre.Length + fragment.Length;
        int endHtml = 105 + body.Length;
        return string.Format(header, endHtml, endFrag) + body;
    }

    static IntPtr FindSMWindow()
    {
        foreach (var proc in Process.GetProcesses())
        {
            try {
                if (proc.MainWindowTitle.Contains("SuperMemo", StringComparison.OrdinalIgnoreCase)
                    && proc.MainWindowHandle != IntPtr.Zero)
                    return proc.MainWindowHandle;
            } catch {}
        }
        return IntPtr.Zero;
    }
}

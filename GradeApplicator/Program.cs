using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Diagnostics;

// ── Win32 API ─────────────────────────────────────────────────────────────
static class Win32
{
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string? cls, string? title);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmd);
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string? cls, string? title);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Explicit)]   public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT
    { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public nint dwExtraInfo; }

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 2;
    public const int SW_RESTORE = 9;

    public static void KeyDown(ushort vk) => SendInput(1, [new INPUT { type=INPUT_KEYBOARD, u=new INPUTUNION{ki=new KEYBDINPUT{wVk=vk}} }], Marshal.SizeOf<INPUT>());
    public static void KeyUp(ushort vk)   => SendInput(1, [new INPUT { type=INPUT_KEYBOARD, u=new INPUTUNION{ki=new KEYBDINPUT{wVk=vk,dwFlags=KEYEVENTF_KEYUP}} }], Marshal.SizeOf<INPUT>());

    public static void KeyPress(ushort vk) { KeyDown(vk); Thread.Sleep(50); KeyUp(vk); Thread.Sleep(60); }
    public static void KeyChord(ushort mod, ushort vk) { KeyDown(mod); KeyDown(vk); Thread.Sleep(50); KeyUp(vk); KeyUp(mod); Thread.Sleep(120); }

    // Virtual key codes
    public const ushort VK_RETURN = 0x0D;
    public const ushort VK_CONTROL= 0x11;
    public const ushort VK_BACK   = 0x08;
    public const ushort VK_J      = 0x4A;
    public const ushort VK_G      = 0x47;
    public static readonly ushort[] VK_DIGITS = [0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39];

    public static void TypeString(string s)
    {
        foreach (char c in s)
        {
            // Use SendInput with UNICODE flag for reliable character input
            var inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = 4 }; // KEYEVENTF_UNICODE
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].u.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = 4 | KEYEVENTF_KEYUP };
            SendInput(2, inputs, Marshal.SizeOf<INPUT>());
            Thread.Sleep(30);
        }
    }
}

// ── Data model ────────────────────────────────────────────────────────────
record GradeRecord(
    [property: JsonPropertyName("elementId")] int ElementId,
    [property: JsonPropertyName("grade")]     int Grade,
    [property: JsonPropertyName("timestamp")] string Timestamp
);

// ── Main ──────────────────────────────────────────────────────────────────
static class Program
{
    static int Main(string[] args)
    {
        var gradesDir = args.Length > 0 ? args[0]
            : Path.Combine(AppContext.BaseDirectory, "..", "grades");
        gradesDir = Path.GetFullPath(gradesDir);

        if (!Directory.Exists(gradesDir)) { Console.WriteLine($"No grades dir: {gradesDir}"); return 1; }

        var files = Directory.GetFiles(gradesDir, "*.json").OrderBy(f => f).ToArray();
        if (files.Length == 0) { Console.WriteLine("No pending grade files found."); return 0; }

        // Find SM window
        var smHwnd = FindSMWindow();
        if (smHwnd == IntPtr.Zero)
        {
            Console.WriteLine("SuperMemo window not found. Please open SuperMemo first.");
            Console.WriteLine("Press Enter to retry…");
            Console.ReadLine();
            smHwnd = FindSMWindow();
            if (smHwnd == IntPtr.Zero) { Console.WriteLine("Still not found. Exiting."); return 1; }
        }

        int totalApplied = 0;
        foreach (var file in files)
        {
            var date    = Path.GetFileNameWithoutExtension(file);
            var reviews = JsonSerializer.Deserialize<List<GradeRecord>>(File.ReadAllText(file));
            if (reviews is null || reviews.Count == 0) continue;

            Console.WriteLine($"\n── {date}: {reviews.Count} grades ──────────────");
            foreach (var r in reviews)
            {
                Console.Write($"  Element {r.ElementId,4}  grade={r.Grade}  … ");
                bool ok = ApplyGrade(smHwnd, r.ElementId, r.Grade);
                Console.WriteLine(ok ? "OK" : "SKIP");
                if (ok) totalApplied++;
            }

            // Archive the file
            File.Move(file, file.Replace(".json", ".applied.json"), overwrite: true);
        }

        Console.WriteLine($"\n✓ Applied {totalApplied} grades. SM has updated the schedule.");
        return 0;
    }

    static IntPtr FindSMWindow()
    {
        // SM18/19 window title contains "SuperMemo"
        foreach (var proc in Process.GetProcesses())
        {
            try
            {
                if (proc.MainWindowTitle.Contains("SuperMemo", StringComparison.OrdinalIgnoreCase)
                    && proc.MainWindowHandle != IntPtr.Zero)
                    return proc.MainWindowHandle;
            }
            catch { }
        }
        return IntPtr.Zero;
    }

    // Navigate SM to element, set to grading state, apply grade key
    static bool ApplyGrade(IntPtr smHwnd, int elementId, int grade)
    {
        if (grade < 0 || grade > 5) return false;

        Win32.ShowWindow(smHwnd, Win32.SW_RESTORE);
        Win32.SetForegroundWindow(smHwnd);
        Thread.Sleep(300);

        // Ctrl+J → Jump to element dialog
        Win32.KeyChord(Win32.VK_CONTROL, Win32.VK_J);
        Thread.Sleep(400);

        // Clear any existing text and type the element ID
        for (int i = 0; i < 8; i++) { Win32.KeyPress(Win32.VK_BACK); }
        Win32.TypeString(elementId.ToString());
        Thread.Sleep(100);
        Win32.KeyPress(Win32.VK_RETURN);
        Thread.Sleep(600); // wait for element to load

        // Ctrl+G to enter grading mode (works in any view mode)
        Win32.KeyChord(Win32.VK_CONTROL, Win32.VK_G);
        Thread.Sleep(300);

        // Press grade digit key (0–5)
        Win32.KeyPress(Win32.VK_DIGITS[grade]);
        Thread.Sleep(200);

        return true;
    }
}

// Logi Flow OSS — ayudante de captura para Windows.
// Lo compila win-capture.js con el compilador de C# que trae Windows (Add-Type).
//
// stdin (órdenes):  "watch <left|right|top|bottom>"  vigila ese borde (no bloquea nada)
//                   "capture"                        bloquea mouse+teclado físicos y los reporta
//                   "keys"                           bloquea y reporta solo el teclado (el mouse se fue
//                                                    a otro equipo); avisa "R" si el mouse vuelve a moverse
//                   "quit"
// stdout (eventos): "E <pos>"            el cursor físico tocó el borde vigilado (pos 0..1)
//                   "M <dx> <dy>"        movimiento crudo (solo en capture)
//                   "B <btn> <0|1>"      botón 1 izq 2 der 3 medio 4 atrás 5 adelante
//                   "W <v> <h>"          rueda en 1/120
//                   "K <scan> <ext> <0|1>" tecla (en todos los modos, para los atajos)
//                   "R"                  en modo keys: el mouse físico se movió aquí otra vez
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class FlowCapture {
  const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
  const int WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_RBUTTONDOWN = 0x204,
            WM_RBUTTONUP = 0x205, WM_MBUTTONDOWN = 0x207, WM_MBUTTONUP = 0x208, WM_MOUSEWHEEL = 0x20A,
            WM_XBUTTONDOWN = 0x20B, WM_XBUTTONUP = 0x20C, WM_MOUSEHWHEEL = 0x20E, WM_INPUT = 0x00FF;
  const uint LLMHF_INJECTED = 1, LLKHF_EXTENDED = 1, LLKHF_INJECTED = 0x10, LLKHF_UP = 0x80;

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct RAWINPUTDEVICE { public ushort usUsagePage, usUsage; public uint dwFlags; public IntPtr hwndTarget; }
  [StructLayout(LayoutKind.Sequential)] struct RAWINPUTHEADER { public uint dwType, dwSize; public IntPtr hDevice, wParam; }
  [StructLayout(LayoutKind.Explicit)] struct RAWMOUSE {
    [FieldOffset(0)] public ushort usFlags; [FieldOffset(4)] public uint ulButtons;
    [FieldOffset(8)] public uint ulRawButtons; [FieldOffset(12)] public int lLastX; [FieldOffset(16)] public int lLastY;
  }

  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint n, uint size);
  [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr h, uint cmd, IntPtr data, ref uint size, uint hdr);

  static HookProc mouseProc = MouseHook, keyProc = KeyHook; // referencias vivas (GC)
  static volatile string mode = "off";
  static volatile string edge = "";
  static bool armed = true;
  static int modeSince = 0, reclaimMoves = 0;
  static bool reclaimSent = false;
  // Los hooks NUNCA escriben directo a stdout: si Node tarda en leer, el hook se
  // bloquearía y Windows lo quitaría en silencio (LowLevelHooksTimeout). Van a una cola.
  static readonly BlockingCollection<string> outQ = new BlockingCollection<string>(4096);
  static void Out(string s) { outQ.TryAdd(s); }
  static IntPtr hMouse = IntPtr.Zero, hKey = IntPtr.Zero;

  static bool InstallHooks() {
    IntPtr mod = GetModuleHandle(null);
    IntPtr m = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, mod, 0);
    IntPtr k = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, mod, 0);
    if (m == IntPtr.Zero || k == IntPtr.Zero) {
      if (m != IntPtr.Zero) UnhookWindowsHookEx(m);
      if (k != IntPtr.Zero) UnhookWindowsHookEx(k);
      return false;
    }
    // Instalar los nuevos antes de quitar los viejos: no queda ningún hueco
    if (hMouse != IntPtr.Zero) UnhookWindowsHookEx(hMouse);
    if (hKey != IntPtr.Zero) UnhookWindowsHookEx(hKey);
    hMouse = m; hKey = k;
    return true;
  }

  class RawWindow : NativeWindow {
    public RawWindow() {
      var cp = new CreateParams(); cp.Parent = new IntPtr(-3); // HWND_MESSAGE
      CreateHandle(cp);
      var dev = new RAWINPUTDEVICE[] { new RAWINPUTDEVICE { usUsagePage = 1, usUsage = 2, dwFlags = 0x100 /*INPUTSINK*/, hwndTarget = Handle } };
      if (!RegisterRawInputDevices(dev, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)))) Console.Error.WriteLine("raw input no disponible");
    }
    protected override void WndProc(ref Message m) {
      if (m.Msg == WM_INPUT && mode == "capture") {
        uint size = 0, hdr = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
        GetRawInputData(m.LParam, 0x10000003, IntPtr.Zero, ref size, hdr);
        IntPtr buf = Marshal.AllocHGlobal((int)size);
        try {
          if (GetRawInputData(m.LParam, 0x10000003, buf, ref size, hdr) == size) {
            var h = (RAWINPUTHEADER)Marshal.PtrToStructure(buf, typeof(RAWINPUTHEADER));
            if (h.dwType == 0) {
              var rm = (RAWMOUSE)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + hdr), typeof(RAWMOUSE));
              if ((rm.usFlags & 1) == 0 && (rm.lLastX != 0 || rm.lLastY != 0)) Out("M " + rm.lLastX + " " + rm.lLastY);
            }
          }
        } finally { Marshal.FreeHGlobal(buf); }
      }
      base.WndProc(ref m);
    }
  }

  static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam) {
    if (code < 0) return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    var s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
    if ((s.flags & LLMHF_INJECTED) != 0) return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    int msg = wParam.ToInt32();

    if (mode == "watch" && msg == WM_MOUSEMOVE && edge != "") {
      int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
      bool at = false; double pos = 0;
      if (edge == "right")  { at = s.pt.x >= vx + vw - 1; pos = (double)(s.pt.y - vy) / Math.Max(vh - 1, 1); }
      if (edge == "left")   { at = s.pt.x <= vx;          pos = (double)(s.pt.y - vy) / Math.Max(vh - 1, 1); }
      if (edge == "bottom") { at = s.pt.y >= vy + vh - 1; pos = (double)(s.pt.x - vx) / Math.Max(vw - 1, 1); }
      if (edge == "top")    { at = s.pt.y <= vy;          pos = (double)(s.pt.x - vx) / Math.Max(vw - 1, 1); }
      if (at && armed) { armed = false; Out("E " + pos.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture)); }
      else if (!at) armed = true;
      return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    if (mode == "keys") {
      // Unos movimientos sueltos justo al cambiar de canal no cuentan
      if (msg == WM_MOUSEMOVE && !reclaimSent && Environment.TickCount - modeSince > 1500 && ++reclaimMoves >= 5) {
        reclaimSent = true; Out("R");
      }
      return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    if (mode != "capture") return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);

    int xb = (int)(s.mouseData >> 16);
    switch (msg) {
      case WM_LBUTTONDOWN: Out("B 1 1"); break; case WM_LBUTTONUP: Out("B 1 0"); break;
      case WM_RBUTTONDOWN: Out("B 2 1"); break; case WM_RBUTTONUP: Out("B 2 0"); break;
      case WM_MBUTTONDOWN: Out("B 3 1"); break; case WM_MBUTTONUP: Out("B 3 0"); break;
      case WM_XBUTTONDOWN: Out("B " + (xb == 1 ? 4 : 5) + " 1"); break;
      case WM_XBUTTONUP: Out("B " + (xb == 1 ? 4 : 5) + " 0"); break;
      case WM_MOUSEWHEEL: Out("W " + (short)xb + " 0"); break;
      case WM_MOUSEHWHEEL: Out("W 0 " + (short)xb); break;
    }
    return new IntPtr(1); // bloquear: el cursor de Windows no se mueve mientras controlas el otro equipo
  }

  static IntPtr KeyHook(int code, IntPtr wParam, IntPtr lParam) {
    if (code < 0) return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
    if ((k.flags & LLKHF_INJECTED) != 0) return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    Out("K " + k.scanCode + " " + ((k.flags & LLKHF_EXTENDED) != 0 ? 1 : 0) + " " + ((k.flags & LLKHF_UP) != 0 ? 0 : 1));
    if (mode == "capture" || mode == "keys") return new IntPtr(1);
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }

  public static void Main() {
    SetProcessDPIAware();
    var rw = new RawWindow();
    if (!InstallHooks()) {
      Console.Error.WriteLine("no se pudieron instalar los hooks: " + Marshal.GetLastWin32Error());
      return;
    }
    var writer = new Thread(() => {
      foreach (var line in outQ.GetConsumingEnumerable()) {
        try { Console.Out.Write(line + "\n"); Console.Out.Flush(); } catch { Application.Exit(); return; }
      }
    });
    writer.IsBackground = true;
    writer.Start();
    // Windows quita los hooks sin avisar si alguna vez tardan: reinstalarlos cada 15 s
    // (en el mismo hilo del bucle de mensajes) y avisar que seguimos vivos.
    var timer = new System.Windows.Forms.Timer();
    timer.Interval = 15000;
    timer.Tick += (o, e) => { InstallHooks(); Out("H"); };
    timer.Start();
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        line = line.Trim();
        if (line == "quit") break;
        modeSince = Environment.TickCount; reclaimMoves = 0; reclaimSent = false;
        if (line == "capture") mode = "capture";
        else if (line == "keys") mode = "keys";
        else if (line.StartsWith("watch ")) { edge = line.Substring(6); mode = "watch"; armed = false; }
        else if (line == "off") mode = "off";
      }
      Application.Exit(); // stdin cerrado (Node murió): salir y soltar los hooks
    });
    reader.IsBackground = true;
    reader.Start();
    Out("READY");
    Application.Run();
  }
}

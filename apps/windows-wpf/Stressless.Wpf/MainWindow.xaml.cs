using Microsoft.Web.WebView2.Core;
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;

namespace Stressless.Wpf;

public partial class MainWindow : Window
{
    private Process? _backend;
    private readonly HttpClient _http = new HttpClient();

    private const string HealthUrl = "http://127.0.0.1:8080/api/presets";
    private const string UiUrl = "http://127.0.0.1:8080";
    private static readonly TimeSpan BackendWait = TimeSpan.FromSeconds(20);

    public MainWindow()
    {
        InitializeComponent();

        // Custom chrome
        DragRegion.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ClickCount == 2) ToggleMaximize();
            else DragMove();
        };
        ResizeGrip.MouseLeftButtonDown += (_, __) =>
        {
            // Start resize from bottom-right
            if (WindowState != WindowState.Maximized)
                SendMessageForResize(ResizeDirection.BottomRight);
        };

        BtnMin.Click += (_, __) => WindowState = WindowState.Minimized;
        BtnMax.Click += (_, __) => ToggleMaximize();
        BtnClose.Click += (_, __) => Close();

        BtnReload.Click += (_, __) => Browser.Reload();
        BtnDevtools.Click += (_, __) => Browser.CoreWebView2?.OpenDevToolsWindow();

        Loaded += async (_, __) =>
        {
            ApplyBackdrop(); // best-effort (Win11 mica / acrylic)
            await BootAsync();
        };
        StateChanged += (_, __) => UpdateMaxIcon();
        Closing += (_, __) => StopBackend();
    }

    private void ToggleMaximize()
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        UpdateMaxIcon();
    }

    private void UpdateMaxIcon()
    {
        // Segoe MDL2: Maximize E922, Restore E923
        IcoMax.Text = (WindowState == WindowState.Maximized) ? "\uE923" : "\uE922";
    }

    private async Task BootAsync()
    {
        StartBundledBackend();
        _ = await WaitForBackendAsync();
        await InitWebViewAsync();
    }

    private static string ResolveBackendExe()
    {
        var baseDir = AppDomain.CurrentDomain.BaseDirectory;
        return Path.Combine(baseDir, "bin", "stressless-server.exe");
    }

    private void StartBundledBackend()
    {
        try
        {
            var exe = ResolveBackendExe();
            if (!File.Exists(exe))
            {
                Debug.WriteLine("[wpf] backend exe not found: " + exe);
                return;
            }

            var psi = new ProcessStartInfo
            {
                FileName = exe,
                WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            _backend = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _backend.OutputDataReceived += (_, e) => { if (e.Data != null) Debug.WriteLine("[backend] " + e.Data); };
            _backend.ErrorDataReceived += (_, e) => { if (e.Data != null) Debug.WriteLine("[backend-err] " + e.Data); };

            _backend.Start();
            _backend.BeginOutputReadLine();
            _backend.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            Debug.WriteLine("[wpf] failed to start backend: " + ex);
        }
    }

    private async Task<bool> WaitForBackendAsync()
    {
        using var cts = new CancellationTokenSource(BackendWait);
        while (!cts.IsCancellationRequested)
        {
            try
            {
                var res = await _http.GetAsync(HealthUrl, cts.Token);
                if (res.IsSuccessStatusCode) return true;
            }
            catch { }
            try { await Task.Delay(400, cts.Token); } catch { }
        }
        return false;
    }

    private async Task InitWebViewAsync()
    {
        try
        {
            await Browser.EnsureCoreWebView2Async();
            Browser.CoreWebView2.Settings.AreDevToolsEnabled = true;
            Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            Browser.Source = new Uri(UiUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show("WebView init failed: " + ex.Message, "Stressless", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void StopBackend()
    {
        try
        {
            if (_backend == null) return;
            if (_backend.HasExited) return;
            _backend.Kill(entireProcessTree: true);
        }
        catch { }
    }

    // ---------------- Backdrop / Mica / Acrylic (best-effort) ----------------

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        UpdateMaxIcon();
    }

    private void ApplyBackdrop()
    {
        // Best-effort: Windows 11 gets Mica if available, otherwise Acrylic on Win10-ish.
        try
        {
            var hwnd = new WindowInteropHelper(this).EnsureHandle();
            SetImmersiveDarkMode(hwnd, true);

            // Try Mica
            int backdrop = 2; // DWMSBT_MAINWINDOW
            DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref backdrop, Marshal.SizeOf<int>());

            // And extend frame a tiny bit (helps with rounded + shadow)
            var margins = new MARGINS { cxLeftWidth = 0, cxRightWidth = 0, cyTopHeight = 1, cyBottomHeight = 0 };
            DwmExtendFrameIntoClientArea(hwnd, ref margins);
        }
        catch
        {
            // ignore
        }
    }

    // ---------------- Resize via WM_SYSCOMMAND ----------------

    private enum ResizeDirection
    {
        Left = 1, Right = 2, Top = 3, TopLeft = 4, TopRight = 5,
        Bottom = 6, BottomLeft = 7, BottomRight = 8
    }

    private void SendMessageForResize(ResizeDirection dir)
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        SendMessage(hwnd, WM_SYSCOMMAND, (IntPtr)(SC_SIZE + (int)dir), IntPtr.Zero);
    }

    private const int WM_SYSCOMMAND = 0x112;
    private const int SC_SIZE = 0xF000;

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    // ---------------- DWM ----------------

    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_SYSTEMBACKDROP_TYPE = 38;

    [StructLayout(LayoutKind.Sequential)]
    private struct MARGINS
    {
        public int cxLeftWidth;
        public int cxRightWidth;
        public int cyTopHeight;
        public int cyBottomHeight;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);

    private static void SetImmersiveDarkMode(IntPtr hwnd, bool enabled)
    {
        if (Environment.OSVersion.Version.Major < 10) return;
        int use = enabled ? 1 : 0;
        _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref use, Marshal.SizeOf<int>());
    }
}

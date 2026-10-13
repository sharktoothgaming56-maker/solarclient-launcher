# SolarClient update progress window (ASCII only - Windows PowerShell 5.x)
# Shown by solar-update-helper.ps1 while the launcher is closed for install.
# A normal app window: not topmost, opens without stealing focus, draggable,
# minimizable, and grouped with SolarClient on the taskbar.
param(
  [string]$StatusFile,
  [string]$VerText = 'the latest version',
  [string]$IconPath = '',
  [int]$CenterX = 0,
  [int]$CenterY = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class SolarUpdateWindow : Form {
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shell32.dll")] public static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);

  static readonly Color Bg = Color.FromArgb(16, 12, 30);
  static readonly Color Line = Color.FromArgb(46, 40, 72);
  static readonly Color Text1 = Color.FromArgb(238, 240, 250);
  static readonly Color Text2 = Color.FromArgb(173, 170, 203);
  static readonly Color Text3 = Color.FromArgb(115, 107, 150);
  static readonly Color Accent = Color.FromArgb(157, 107, 255);
  static readonly Color Accent2 = Color.FromArgb(229, 97, 216);

  readonly string statusFile;
  readonly string verText;
  readonly float s;
  readonly Image logo;
  readonly Font fTitle, fSub, fStatus, fFoot;
  readonly Timer timer = new Timer();
  readonly DateTime start = DateTime.Now;
  string status = "Closing SolarClient...";
  float target = 5f, shown = 0f;
  int lastRead = -1;
  bool minHover;
  Rectangle minRect;

  public SolarUpdateWindow(string statusFile, string verText, string iconPath, int cx, int cy) {
    this.statusFile = statusFile;
    this.verText = verText;
    using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) { s = g.DpiX / 96f; }

    Text = "SolarClient - Updating";
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = true;
    TopMost = false;
    DoubleBuffered = true;
    BackColor = Bg;
    Size = new Size(S(440), S(168));
    if (cx > 0 && cy > 0) {
      StartPosition = FormStartPosition.Manual;
      Rectangle wa = Screen.FromPoint(new Point(cx, cy)).WorkingArea;
      int x = Math.Max(wa.Left, Math.Min(cx - Width / 2, wa.Right - Width));
      int y = Math.Max(wa.Top, Math.Min(cy - Height / 2, wa.Bottom - Height));
      Location = new Point(x, y);
    } else {
      StartPosition = FormStartPosition.CenterScreen;
    }

    try {
      if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath)) {
        Icon = new Icon(iconPath);
        logo = LoadIcoFrame(iconPath, S(32));
      }
    } catch { }

    fTitle = new Font("Segoe UI Semibold", 17f * s, FontStyle.Regular, GraphicsUnit.Pixel);
    fSub = new Font("Segoe UI", 12.5f * s, FontStyle.Regular, GraphicsUnit.Pixel);
    fStatus = new Font("Segoe UI", 13f * s, FontStyle.Regular, GraphicsUnit.Pixel);
    fFoot = new Font("Segoe UI", 11.5f * s, FontStyle.Regular, GraphicsUnit.Pixel);

    minRect = new Rectangle(Width - S(44), S(10), S(32), S(26));
    using (GraphicsPath p = Round(new Rectangle(0, 0, Width, Height), S(14))) { Region = new Region(p); }

    MouseDown += OnDrag;
    MouseMove += delegate(object o, MouseEventArgs e) {
      bool h = minRect.Contains(e.Location);
      if (h != minHover) { minHover = h; Cursor = h ? Cursors.Hand : Cursors.Default; Invalidate(minRect); }
    };
    MouseLeave += delegate { if (minHover) { minHover = false; Invalidate(minRect); } };

    timer.Interval = 33;
    timer.Tick += OnTick;
    Shown += delegate { timer.Start(); };
  }

  int S(float v) { return (int)Math.Round(v * s); }

  // Icon.ToBitmap() garbles PNG-compressed .ico frames on .NET Framework, so
  // pick the smallest frame >= size and decode its bytes directly.
  static Image LoadIcoFrame(string path, int size) {
    byte[] b = File.ReadAllBytes(path);
    int n = BitConverter.ToUInt16(b, 4);
    int best = -1, bestW = 0;
    for (int i = 0; i < n; i++) {
      int w = b[6 + 16 * i]; if (w == 0) w = 256;
      bool better = best < 0 || (w >= size && (bestW < size || w < bestW)) || (bestW < size && w > bestW);
      if (better) { best = i; bestW = w; }
    }
    if (best < 0) return null;
    int len = (int)BitConverter.ToUInt32(b, 6 + 16 * best + 8);
    int off = (int)BitConverter.ToUInt32(b, 6 + 16 * best + 12);
    if (b[off] == 0x89) return new Bitmap(new MemoryStream(b, off, len));
    using (Icon ic = new Icon(path, bestW, bestW)) return ic.ToBitmap();
  }

  // Show without pulling focus from whatever the user is doing.
  protected override bool ShowWithoutActivation { get { return true; } }

  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.Style |= 0x00020000;      // WS_MINIMIZEBOX: taskbar click minimizes/restores
      cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
      return cp;
    }
  }

  void OnDrag(object sender, MouseEventArgs e) {
    if (e.Button != MouseButtons.Left) return;
    if (minRect.Contains(e.Location)) { WindowState = FormWindowState.Minimized; return; }
    ReleaseCapture();
    SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); // WM_NCLBUTTONDOWN, HTCAPTION
  }

  void OnTick(object sender, EventArgs e) {
    int elapsedMs = (int)(DateTime.Now - start).TotalMilliseconds;
    if (elapsedMs / 300 != lastRead) {
      lastRead = elapsedMs / 300;
      ReadStatus();
      // Creep forward slowly between real steps so the bar never looks frozen.
      if (shown >= target - 0.5f && target < 97f) target = Math.Min(target + 0.25f, 97f);
    }
    if (elapsedMs > 300000) { Close(); return; }
    shown += (target - shown) * 0.12f;
    Invalidate();
  }

  void ReadStatus() {
    try {
      if (!File.Exists(statusFile)) return;
      string raw = File.ReadAllText(statusFile).Trim();
      string[] parts = raw.Split(new char[] { '|' }, 2);
      if (parts[0] == "done") { timer.Stop(); Close(); return; }
      float p;
      if (float.TryParse(parts[0], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out p) && p > target) target = Math.Min(100f, p);
      if (parts.Length > 1 && parts[1].Length > 0) status = parts[1];
    } catch { }
  }

  static GraphicsPath Round(Rectangle r, int rad) {
    GraphicsPath p = new GraphicsPath();
    int d = Math.Max(1, rad * 2);
    if (d > r.Height) d = r.Height;
    if (d > r.Width) d = r.Width;
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

    using (LinearGradientBrush glow = new LinearGradientBrush(new Rectangle(0, 0, Width, S(70)),
        Color.FromArgb(40, Accent), Color.FromArgb(0, Accent), LinearGradientMode.Vertical)) {
      g.FillRectangle(glow, 0, 0, Width, S(70));
    }
    using (Pen border = new Pen(Line, 1f))
    using (GraphicsPath p = Round(new Rectangle(0, 0, Width - 1, Height - 1), S(14))) { g.DrawPath(border, p); }

    int pad = S(22);
    int textX = pad;
    if (logo != null) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      using (GraphicsPath lp = Round(new Rectangle(pad, S(20), S(32), S(32)), S(8))) {
        g.SetClip(lp);
        g.DrawImage(logo, pad, S(20), S(32), S(32));
        g.ResetClip();
      }
      textX = pad + S(44);
    }
    TextRenderer.DrawText(g, "SolarClient", fTitle, new Point(textX - S(3), S(16)), Text1, TextFormatFlags.NoPadding);
    TextRenderer.DrawText(g, "Updating to " + verText, fSub, new Point(textX - S(2), S(39)), Text2, TextFormatFlags.NoPadding);

    // Minimize button.
    if (minHover) using (SolidBrush hb = new SolidBrush(Color.FromArgb(28, 255, 255, 255)))
      using (GraphicsPath mp = Round(minRect, S(6))) g.FillPath(hb, mp);
    using (Pen mpen = new Pen(minHover ? Text1 : Text2, Math.Max(1f, 1.4f * s))) {
      int my = minRect.Top + minRect.Height / 2;
      g.DrawLine(mpen, minRect.Left + S(11), my, minRect.Right - S(11), my);
    }

    int pct = (int)Math.Round(Math.Min(100f, shown));
    TextRenderer.DrawText(g, status, fStatus, new Rectangle(pad, S(76), Width - pad * 2 - S(48), S(22)), Text1,
        TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.Left);
    TextRenderer.DrawText(g, pct + "%", fStatus, new Rectangle(Width - pad - S(48), S(76), S(48), S(22)), Text2,
        TextFormatFlags.NoPadding | TextFormatFlags.Right);

    Rectangle track = new Rectangle(pad, S(104), Width - pad * 2, S(8));
    using (SolidBrush tb = new SolidBrush(Color.FromArgb(34, 255, 255, 255)))
    using (GraphicsPath tp = Round(track, track.Height / 2)) g.FillPath(tb, tp);
    int fw = (int)(track.Width * Math.Max(0f, Math.Min(100f, shown)) / 100f);
    if (fw >= track.Height) {
      Rectangle fill = new Rectangle(track.X, track.Y, fw, track.Height);
      using (LinearGradientBrush fb = new LinearGradientBrush(new Rectangle(track.X, track.Y, Math.Max(1, track.Width), track.Height), Accent, Accent2, LinearGradientMode.Horizontal))
      using (GraphicsPath fp = Round(fill, track.Height / 2)) g.FillPath(fb, fp);
    }

    int secs = (int)(DateTime.Now - start).TotalSeconds;
    TextRenderer.DrawText(g, "SolarClient reopens automatically  -  " + secs + "s", fFoot,
        new Point(pad, S(128)), Text3, TextFormatFlags.NoPadding);
  }
}
'@

try {
  Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop
} catch {
  exit 1
}
[void][SolarUpdateWindow]::SetProcessDPIAware()
[void][SolarUpdateWindow]::SetCurrentProcessExplicitAppUserModelID('com.solarclient.launcher')
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object SolarUpdateWindow -ArgumentList $StatusFile, $VerText, $IconPath, $CenterX, $CenterY
[System.Windows.Forms.Application]::Run($form)

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
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class SolarUpdateWindow : Form {
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int n, int v);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shell32.dll")] public static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);

  static readonly Color Bg = Color.FromArgb(22, 14, 40);
  static readonly Color Text1 = Color.FromArgb(255, 255, 255);
  static readonly Color Gold = Color.FromArgb(255, 212, 94);
  static readonly Color Text3 = Color.FromArgb(186, 176, 214);
  static readonly Color BtnTop = Color.FromArgb(131, 94, 205);
  static readonly Color BtnBot = Color.FromArgb(60, 41, 92);

  readonly string statusFile;
  readonly string verText;
  readonly float s;
  readonly Image logo;
  readonly Font fTitle, fSub, fStatus, fPct, fStep, fFoot;
  readonly Timer timer = new Timer();
  readonly DateTime start = DateTime.Now;
  readonly Random rng = new Random();
  readonly List<Point> snake = new List<Point>();
  const int SC = 16, SR = 9;
  int gameMode, sdir, snext, fx, fy, sscore, stick;
  bool sdead, keysOn, wasR;
  int sheet, cart, ox, oy, oscore, omiss, otick, hold;
  bool odead;
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
    Size = new Size(S(500), S(540));
    KeyPreview = true;
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
        logo = LoadIcoFrame(iconPath, S(42));
      }
    } catch { }

    fTitle = PickFont("Segoe UI", 18f * s, FontStyle.Bold);
    fSub = PickFont("Segoe UI", 12f * s, FontStyle.Bold);
    fStatus = PickFont("Segoe UI", 13f * s, FontStyle.Bold);
    fPct = PickFont("Segoe UI", 16f * s, FontStyle.Bold);
    fStep = PickFont("Segoe UI", 11f * s, FontStyle.Bold);
    fFoot = PickFont("Segoe UI", 12f * s, FontStyle.Bold);
    ResetSnake();
    ResetCatch();

    minRect = new Rectangle(Width - S(54), S(16), S(34), S(26));
    using (GraphicsPath p = Round(new Rectangle(0, 0, Width, Height), S(16))) { Region = new Region(p); }

    MouseDown += OnDrag;
    KeyDown += OnKey;
    MouseMove += delegate(object o, MouseEventArgs e) {
      bool h = minRect.Contains(e.Location) || HitBtn(e.Location);
      if (h != minHover) { minHover = h; Cursor = h ? Cursors.Hand : Cursors.Default; Invalidate(minRect); }
    };
    MouseLeave += delegate { if (minHover) { minHover = false; Invalidate(minRect); } };

    timer.Interval = 33;
    timer.Tick += OnTick;
    Shown += delegate { timer.Start(); };
  }

  int S(float v) { return (int)Math.Round(v * s); }

  static Font PickFont(string name, float px, FontStyle style) {
    try { return new Font(name, px, style, GraphicsUnit.Pixel); }
    catch { return new Font("Segoe UI", px, FontStyle.Bold, GraphicsUnit.Pixel); }
  }

  void DrawStroke(Graphics g, string text, Font font, Point origin, Color fill, float weight) {
    using (GraphicsPath path = new GraphicsPath()) {
      float em = font.Size;
      path.AddString(text, font.FontFamily, (int)font.Style, em, origin, StringFormat.GenericTypographic);
      using (Pen pen = new Pen(Color.Black, Math.Max(1f, weight)) { LineJoin = LineJoin.Round }) g.DrawPath(pen, path);
      using (SolidBrush b = new SolidBrush(fill)) g.FillPath(b, path);
    }
  }

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

  Rectangle SnakeBtn() { return new Rectangle(S(16), S(132), S(88), S(28)); }
  Rectangle CatchBtn() { return new Rectangle(S(110), S(132), S(88), S(28)); }
  Rectangle RestartBtn() { return new Rectangle(Width - S(108), S(132), S(92), S(28)); }
  Rectangle RulesBtn() { return new Rectangle(S(16), S(168), S(78), S(26)); }
  Rectangle AboutBtn() { return new Rectangle(S(100), S(168), S(78), S(26)); }
  Rectangle HowBtn() { return new Rectangle(S(184), S(168), S(118), S(26)); }
  Rectangle Board() { return new Rectangle(S(16), S(206), Width - S(32), Height - S(222)); }
  Rectangle BackBtn() { Rectangle b = Board(); return new Rectangle(b.X + S(14), b.Bottom - S(42), S(78), S(28)); }
  bool HitBtn(Point p) {
    return SnakeBtn().Contains(p) || CatchBtn().Contains(p) || RestartBtn().Contains(p)
      || RulesBtn().Contains(p) || AboutBtn().Contains(p) || HowBtn().Contains(p) || (sheet != 0 && BackBtn().Contains(p));
  }

  void TakeKeys() {
    keysOn = true;
    int ex = GetWindowLong(Handle, -20);
    if ((ex & 0x08000000) != 0) SetWindowLong(Handle, -20, ex & ~0x08000000);
    try { Activate(); } catch { }
    SetForegroundWindow(Handle);
  }

  void OnDrag(object sender, MouseEventArgs e) {
    if (e.Button != MouseButtons.Left) return;
    TakeKeys();
    if (minRect.Contains(e.Location)) { WindowState = FormWindowState.Minimized; return; }
    if (SnakeBtn().Contains(e.Location)) { gameMode = 0; sheet = 0; Invalidate(); return; }
    if (CatchBtn().Contains(e.Location)) { gameMode = 1; sheet = 0; Invalidate(); return; }
    if (RestartBtn().Contains(e.Location)) { if (gameMode == 0) ResetSnake(); else ResetCatch(); sheet = 0; Invalidate(); return; }
    if (RulesBtn().Contains(e.Location)) { sheet = sheet == 1 ? 0 : 1; Invalidate(); return; }
    if (AboutBtn().Contains(e.Location)) { sheet = sheet == 2 ? 0 : 2; Invalidate(); return; }
    if (HowBtn().Contains(e.Location)) { sheet = sheet == 3 ? 0 : 3; Invalidate(); return; }
    if (sheet != 0 && BackBtn().Contains(e.Location)) { sheet = 0; Invalidate(); return; }
    if (Board().Contains(e.Location)) return;
    ReleaseCapture();
    SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
  }

  bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  void Aim(int dir) {
    if (sdead) return;
    if ((dir + 2) % 4 == snext) return;
    snext = dir;
  }

  void ReadHeld() {
    if (!keysOn || sheet != 0) return;
    if (!ContainsFocus && Form.ActiveForm != this) return;
    bool r = Down(0x52);
    if (r && !wasR) { if (gameMode == 0) ResetSnake(); else ResetCatch(); }
    wasR = r;
    if (Down(0x31)) { gameMode = 0; return; }
    if (Down(0x32)) { gameMode = 1; return; }
    if (gameMode == 0) {
      if (Down(0x26) || Down(0x57)) Aim(0);
      else if (Down(0x27) || Down(0x44)) Aim(1);
      else if (Down(0x28) || Down(0x53)) Aim(2);
      else if (Down(0x25) || Down(0x41)) Aim(3);
    } else if (++hold >= 2) {
      hold = 0;
      if (Down(0x25) || Down(0x41)) cart = Math.Max(0, cart - 1);
      if (Down(0x27) || Down(0x44)) cart = Math.Min(SC - 3, cart + 1);
    }
  }

  void OnKey(object sender, KeyEventArgs e) {
    Keys k = e.KeyCode;
    if (k == Keys.D1 || k == Keys.NumPad1) { gameMode = 0; return; }
    if (k == Keys.D2 || k == Keys.NumPad2) { gameMode = 1; return; }
    if (k == Keys.R) { if (gameMode == 0) ResetSnake(); else ResetCatch(); return; }
    if (gameMode == 0) {
      if ((k == Keys.Up || k == Keys.W) && snext != 2) snext = 0;
      else if ((k == Keys.Right || k == Keys.D) && snext != 3) snext = 1;
      else if ((k == Keys.Down || k == Keys.S) && snext != 0) snext = 2;
      else if ((k == Keys.Left || k == Keys.A) && snext != 1) snext = 3;
    } else {
      if (k == Keys.Left || k == Keys.A) cart = Math.Max(0, cart - 1);
      if (k == Keys.Right || k == Keys.D) cart = Math.Min(SC - 3, cart + 1);
    }
  }

  bool OnSnake(int x, int y) {
    for (int i = 0; i < snake.Count; i++) if (snake[i].X == x && snake[i].Y == y) return true;
    return false;
  }

  void PlaceFood() {
    for (int n = 0; n < 80; n++) {
      fx = rng.Next(SC); fy = rng.Next(SR);
      if (!OnSnake(fx, fy)) return;
    }
  }

  void ResetSnake() {
    snake.Clear();
    snake.Add(new Point(4, 4));
    snake.Add(new Point(3, 4));
    snake.Add(new Point(2, 4));
    sdir = 1; snext = 1; sscore = 0; sdead = false; stick = 0;
    PlaceFood();
  }

  void ResetCatch() {
    cart = 6; ox = rng.Next(SC); oy = 0; oscore = 0; omiss = 0; otick = 0; odead = false;
  }

  void StepSnake() {
    if (sdead) return;
    sdir = snext;
    Point h = snake[0];
    int nx = h.X + (sdir == 1 ? 1 : sdir == 3 ? -1 : 0);
    int ny = h.Y + (sdir == 2 ? 1 : sdir == 0 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= SC || ny >= SR || OnSnake(nx, ny)) { sdead = true; return; }
    snake.Insert(0, new Point(nx, ny));
    if (nx == fx && ny == fy) { sscore++; PlaceFood(); }
    else snake.RemoveAt(snake.Count - 1);
  }

  void StepCatch() {
    if (odead) return;
    oy++;
    if (oy >= SR - 1) {
      if (ox >= cart && ox < cart + 3) { oscore++; ox = rng.Next(SC); oy = 0; }
      else {
        omiss++;
        ox = rng.Next(SC); oy = 0;
        if (omiss >= 3) odead = true;
      }
    }
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
    ReadHeld();
    if (sheet == 0 && gameMode == 0) {
      if (++stick >= 4) { stick = 0; StepSnake(); }
    } else if (sheet == 0 && ++otick >= 5) {
      otick = 0; StepCatch();
    }
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

  void DrawChip(Graphics g, Rectangle box, string text, bool on) {
    Color top = on ? BtnTop : Color.FromArgb(36, 28, 52);
    Color bot = on ? BtnBot : Color.FromArgb(22, 16, 34);
    using (LinearGradientBrush br = new LinearGradientBrush(box, top, bot, LinearGradientMode.Vertical))
    using (GraphicsPath path = Round(box, S(8))) g.FillPath(br, path);
    using (Pen pen = new Pen(Color.Black, Math.Max(2f, 2f * s)))
    using (GraphicsPath path = Round(box, S(8))) g.DrawPath(pen, path);
    Size sz = TextRenderer.MeasureText(text, fStep, new Size(200, 30), TextFormatFlags.NoPadding);
    DrawStroke(g, text, fStep, new Point(box.X + (box.Width - sz.Width) / 2, box.Y + S(5)), on ? Text1 : Text3, 1.3f * s);
  }

  Rectangle CellBox(Rectangle board, int x, int y, int wCells) {
    int cw = Math.Max(6, board.Width / SC);
    int ch = Math.Max(6, board.Height / SR);
    int gap = Math.Max(2, S(2));
    return new Rectangle(board.X + x * cw + gap, board.Y + y * ch + gap, Math.Max(4, cw * wCells - gap * 2), Math.Max(4, ch - gap * 2));
  }

  void DrawBlock(Graphics g, Rectangle cell, Color top, Color bot) {
    if (cell.Width < 2 || cell.Height < 2) return;
    using (LinearGradientBrush br = new LinearGradientBrush(cell, top, bot, LinearGradientMode.Vertical))
    using (GraphicsPath path = Round(cell, Math.Max(3, cell.Height / 4))) g.FillPath(br, path);
    using (Pen pen = new Pen(Color.Black, Math.Max(1.5f, 1.6f * s)))
    using (GraphicsPath path = Round(cell, Math.Max(3, cell.Height / 4))) g.DrawPath(pen, path);
    using (Pen hi = new Pen(Color.FromArgb(90, 255, 255, 255), Math.Max(1f, s)))
      g.DrawLine(hi, cell.X + S(3), cell.Y + S(2), cell.Right - S(3), cell.Y + S(2));
  }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    using (LinearGradientBrush face = new LinearGradientBrush(ClientRectangle, Color.FromArgb(54, 36, 88), Color.FromArgb(16, 10, 28), LinearGradientMode.Vertical))
      g.FillRectangle(face, ClientRectangle);
    using (Pen border = new Pen(Color.Black, Math.Max(2f, 2f * s)))
    using (GraphicsPath p = Round(new Rectangle(1, 1, Width - 3, Height - 3), S(16))) g.DrawPath(border, p);

    int pad = S(16);
    int logoBox = S(36);
    Rectangle lr = new Rectangle(pad, S(14), logoBox, logoBox);
    if (logo != null) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      using (GraphicsPath lp = Round(lr, S(10))) {
        g.SetClip(lp);
        g.DrawImage(logo, lr);
        g.ResetClip();
      }
    }
    using (Pen lp = new Pen(Color.Black, Math.Max(2f, 2f * s)))
    using (GraphicsPath edge = Round(lr, S(10))) g.DrawPath(lp, edge);
    int textX = pad + logoBox + S(10);
    DrawStroke(g, "SolarClient", fTitle, new Point(textX, S(12)), Text1, 2f * s);
    DrawStroke(g, verText, fSub, new Point(textX, S(34)), Gold, 1.4f * s);

    using (GraphicsPath mp = Round(minRect, S(8))) {
      using (LinearGradientBrush mb = new LinearGradientBrush(minRect, BtnTop, BtnBot, LinearGradientMode.Vertical))
        g.FillPath(mb, mp);
      using (Pen mpen = new Pen(Color.Black, Math.Max(2f, 2f * s))) g.DrawPath(mpen, mp);
    }
    using (Pen dash = new Pen(Color.White, Math.Max(2f, 2f * s))) {
      int my = minRect.Top + minRect.Height / 2;
      g.DrawLine(dash, minRect.Left + S(9), my, minRect.Right - S(9), my);
    }

    int pct = (int)Math.Round(Math.Min(100f, shown));
    TextRenderer.DrawText(g, status, fStatus, new Rectangle(pad, S(58), Width - pad * 2 - S(56), S(18)), Text1,
      TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
    DrawStroke(g, pct + "%", fPct, new Point(Width - pad - S(46), S(54)), Text1, 2f * s);
    Rectangle track = new Rectangle(pad, S(78), Width - pad * 2, S(12));
    using (SolidBrush edgeB = new SolidBrush(Color.Black))
    using (GraphicsPath tp = Round(track, S(6))) g.FillPath(edgeB, tp);
    Rectangle inner = new Rectangle(track.X + 2, track.Y + 2, track.Width - 4, track.Height - 4);
    using (SolidBrush well = new SolidBrush(Color.FromArgb(12, 8, 22)))
    using (GraphicsPath ip = Round(inner, S(4))) g.FillPath(well, ip);
    int fw = (int)(inner.Width * Math.Max(0f, Math.Min(100f, shown)) / 100f);
    if (fw > 6) {
      Rectangle fill = new Rectangle(inner.X, inner.Y, fw, inner.Height);
      using (LinearGradientBrush fb = new LinearGradientBrush(fill, BtnTop, BtnBot, LinearGradientMode.Vertical))
      using (GraphicsPath fp = Round(fill, S(4))) g.FillPath(fb, fp);
    }

    DrawStroke(g, "GAMES", fStep, new Point(pad, S(108)), Gold, 1.4f * s);
    string score = gameMode == 0 ? ("Score " + sscore) : ("Score " + oscore + "   Miss " + omiss);
    Size sc = TextRenderer.MeasureText(score, fStatus, new Size(240, 24), TextFormatFlags.NoPadding);
    TextRenderer.DrawText(g, score, fStatus, new Point(Width - pad - sc.Width, S(106)), Text1, TextFormatFlags.NoPadding);

    DrawChip(g, SnakeBtn(), "Snake", gameMode == 0);
    DrawChip(g, CatchBtn(), "Catch", gameMode == 1);
    DrawChip(g, RestartBtn(), "Restart", false);
    DrawChip(g, RulesBtn(), "Rules", sheet == 1);
    DrawChip(g, AboutBtn(), "About", sheet == 2);
    DrawChip(g, HowBtn(), "How to play", sheet == 3);

    Rectangle board = Board();
    using (SolidBrush bb = new SolidBrush(Color.FromArgb(10, 7, 18)))
    using (GraphicsPath bp = Round(board, S(12))) g.FillPath(bb, bp);
    using (Pen frame = new Pen(Color.Black, Math.Max(2f, 2f * s)))
    using (GraphicsPath bp = Round(board, S(12))) g.DrawPath(frame, bp);

    if (sheet != 0) DrawSheet(g, board);
    else if (gameMode == 0) DrawSnake(g, board);
    else DrawCatch(g, board);
  }

  void DrawSnake(Graphics g, Rectangle board) {
    using (Pen grid = new Pen(Color.FromArgb(22, 255, 255, 255), 1f)) {
      int cw = Math.Max(6, board.Width / SC);
      int ch = Math.Max(6, board.Height / SR);
      for (int x = 1; x < SC; x++) g.DrawLine(grid, board.X + x * cw, board.Y + S(6), board.X + x * cw, board.Bottom - S(6));
      for (int y = 1; y < SR; y++) g.DrawLine(grid, board.X + S(6), board.Y + y * ch, board.Right - S(6), board.Y + y * ch);
    }
    DrawBlock(g, CellBox(board, fx, fy, 1), Color.FromArgb(255, 224, 120), Color.FromArgb(196, 140, 32));
    for (int i = snake.Count - 1; i >= 0; i--) {
      bool head = i == 0;
      Color top = head ? Color.FromArgb(196, 164, 255) : Color.FromArgb(150, 112, 214);
      Color bot = head ? Color.FromArgb(92, 62, 150) : BtnBot;
      Rectangle cell = CellBox(board, snake[i].X, snake[i].Y, 1);
      DrawBlock(g, cell, top, bot);
      if (!head) continue;
      int ox = sdir == 1 ? S(3) : sdir == 3 ? -S(3) : 0;
      int oy2 = sdir == 2 ? S(3) : sdir == 0 ? -S(3) : 0;
      int px = sdir == 0 || sdir == 2 ? S(4) : 0;
      int py = sdir == 1 || sdir == 3 ? S(4) : 0;
      using (SolidBrush eye = new SolidBrush(Color.Black)) {
        g.FillEllipse(eye, cell.X + cell.Width / 2 - px + ox - S(2), cell.Y + cell.Height / 2 - py + oy2 - S(2), S(4), S(4));
        g.FillEllipse(eye, cell.X + cell.Width / 2 + px + ox - S(2), cell.Y + cell.Height / 2 + py + oy2 - S(2), S(4), S(4));
      }
    }
    if (!keysOn) TextRenderer.DrawText(g, "Click to play", fStatus, board, Text3, TextFormatFlags.HorizontalCenter | TextFormatFlags.Bottom);
    if (sdead) TextRenderer.DrawText(g, "Crashed", fTitle, board, Text1, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
  }

  void DrawCatch(Graphics g, Rectangle board) {
    int cw = Math.Max(6, board.Width / SC);
    int ch = Math.Max(6, board.Height / SR);
    int floor = board.Y + (SR - 1) * ch;
    using (Pen ground = new Pen(Color.FromArgb(70, 255, 255, 255), Math.Max(1f, s)))
      g.DrawLine(ground, board.X + S(8), floor, board.Right - S(8), floor);
    if (oy < SR - 1) {
      Rectangle ore = CellBox(board, ox, oy, 1);
      Rectangle shade = new Rectangle(ore.X + S(2), ore.Y + S(3), ore.Width, ore.Height);
      using (SolidBrush sh = new SolidBrush(Color.FromArgb(70, 0, 0, 0))) g.FillRectangle(sh, shade);
      DrawBlock(g, ore, Color.FromArgb(255, 224, 120), Color.FromArgb(196, 140, 32));
    }
    Rectangle cartR = CellBox(board, cart, SR - 1, 3);
    DrawBlock(g, cartR, Color.FromArgb(168, 130, 230), BtnBot);
    using (SolidBrush wheel = new SolidBrush(Color.Black)) {
      g.FillEllipse(wheel, cartR.X + S(4), cartR.Bottom - S(5), S(5), S(5));
      g.FillEllipse(wheel, cartR.Right - S(10), cartR.Bottom - S(5), S(5), S(5));
    }
    if (!keysOn) TextRenderer.DrawText(g, "Click to play", fStatus, board, Text3, TextFormatFlags.HorizontalCenter | TextFormatFlags.Top);
    if (odead) TextRenderer.DrawText(g, "Out", fTitle, board, Text1, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
  }

  void DrawSheet(Graphics g, Rectangle board) {
    string title, a, b, c, d;
    bool snake = gameMode == 0;
    if (sheet == 1) {
      title = "Rules";
      if (snake) { a = "Eat the gold block"; b = "You grow each time"; c = "Walls end the run"; d = "Your body ends the run"; }
      else { a = "Catch the falling block"; b = "Cart is three blocks wide"; c = "Three misses ends it"; d = "The last row is the floor"; }
    } else if (sheet == 2) {
      title = "About";
      if (snake) { a = "A snake on a grid"; b = "Eyes mark the head"; c = "Score is blocks eaten"; d = "It keeps moving"; }
      else { a = "Blocks fall from the top"; b = "Slide the cart under one"; c = "Score is blocks caught"; d = "Misses are counted"; }
    } else {
      title = "How to play";
      if (snake) { a = "Click this window once"; b = "Arrows or W A S D"; c = "Restart puts you back"; d = "1 Snake    2 Catch"; }
      else { a = "Click this window once"; b = "Left Right or A D"; c = "Restart puts you back"; d = "1 Snake    2 Catch"; }
    }
    DrawStroke(g, title, fTitle, new Point(board.X + S(16), board.Y + S(16)), Text1, 2f * s);
    string[] lines = new string[] { a, b, c, d };
    for (int i = 0; i < lines.Length; i++) {
      int y = board.Y + S(58) + i * S(28);
      using (SolidBrush dot = new SolidBrush(Color.FromArgb(184, 140, 255)))
        g.FillEllipse(dot, board.X + S(18), y + S(4), S(8), S(8));
      using (Pen ring = new Pen(Color.Black, 1.5f))
        g.DrawEllipse(ring, board.X + S(18), y + S(4), S(8), S(8));
      TextRenderer.DrawText(g, lines[i], fStatus, new Point(board.X + S(36), y), Text1, TextFormatFlags.NoPadding);
    }
    DrawChip(g, BackBtn(), "Back", true);
  }
}


'@

try {
  Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
[void][SolarUpdateWindow]::SetProcessDPIAware()
[void][SolarUpdateWindow]::SetCurrentProcessExplicitAppUserModelID('com.solarclient.launcher')
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object SolarUpdateWindow -ArgumentList $StatusFile, $VerText, $IconPath, $CenterX, $CenterY
[System.Windows.Forms.Application]::Run($form)

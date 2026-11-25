using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security;
using System.Threading.Tasks;
using System.Windows.Forms;
using CyberPad.Install;
using CyberPad.Install.UI;

namespace CyberPad.Setup
{
    /// <summary>
    /// The setup window (spec, "The setup window" and "Choosing the folder"). Everything is laid out from
    /// the Windows message font, so it follows 100 to 200 percent scaling.
    /// </summary>
    internal sealed class SetupForm : Form
    {
        private const string Caption = "CyberPad Setup";
        private const int DebounceMilliseconds = 300;

        private readonly SetupPlan _plan;
        private readonly string _version;
        private readonly InstallEnvironment _env;
        private readonly IRegistry _registry;
        private readonly IFileSystemProbe _probe;
        private readonly Assembly _assembly;

        private readonly Label _heading;
        private readonly Label _intro;
        private readonly Label _folderLabel;
        private readonly TableLayoutPanel _folderRow;
        private readonly TextBox _folder;
        private readonly Button _browse;
        private readonly Label _status;
        private readonly CheckBox _startAfter;
        private readonly ProgressBar _progress;
        private readonly Button _install;
        private readonly Button _cancel;
        private readonly Timer _debounce;

        private InstallPathResult? _current;
        private int _sequence;
        private bool _busy;
        private bool _finished;
        private string? _installedDir;

        public SetupForm(SetupPlan plan, string version, InstallEnvironment env, IRegistry registry, IFileSystemProbe probe, Assembly assembly)
        {
            _plan = plan;
            _version = version;
            _env = env;
            _registry = registry;
            _probe = probe;
            _assembly = assembly;

            Font font = UiCommon.MessageFont;
            Font = font;
            AutoScaleMode = AutoScaleMode.None;
            Text = Caption;
            Icon = UiCommon.AppIcon();
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(font.Height);

            int width = UiCommon.ContentWidth(font) + font.Height * 6;
            int gap = font.Height / 2;

            _heading = UiCommon.WrappingLabel(plan.Heading, UiCommon.HeadingFont(font), width);
            _intro = UiCommon.WrappingLabel(
                "CyberPad is installed for your Windows account only.\r\nYour notes are stored separately and are not affected.", font, width);

            _folderLabel = new Label { Text = "&Install in:", AutoSize = true, UseMnemonic = true, Margin = new Padding(0, 0, 0, gap / 2) };

            _folder = new TextBox
            {
                Text = plan.Folder,
                ReadOnly = plan.IsUpdate,
                AccessibleName = "Install in",
                Anchor = AnchorStyles.Left | AnchorStyles.Right,
                Margin = new Padding(0, 0, gap, 0),
                MaxLength = InstallPathPolicy.MaxInputLength,
            };
            _browse = new Button { Text = "&Browse…", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = new Padding(0), Enabled = !plan.IsUpdate };

            _folderRow = new TableLayoutPanel { ColumnCount = 2, RowCount = 1, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = new Padding(0, 0, 0, gap / 2), Dock = DockStyle.Fill };
            _folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            _folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _folderRow.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            _folderRow.Controls.Add(_folder, 0, 0);
            _folderRow.Controls.Add(_browse, 1, 0);

            _status = UiCommon.WrappingLabel(plan.FixedStatus ?? string.Empty, font, width);
            _status.MinimumSize = new Size(width, font.Height * 2);
            _status.Margin = new Padding(0, 0, 0, font.Height);

            _startAfter = new CheckBox { Text = "&Start CyberPad when setup finishes", Checked = true, AutoSize = true, Margin = new Padding(0, 0, 0, font.Height) };

            _progress = new ProgressBar { AccessibleName = SetupTexts.ProgressName, Minimum = 0, Maximum = 100, Style = ProgressBarStyle.Continuous, Dock = DockStyle.Fill, Visible = false, Margin = new Padding(0, 0, 0, font.Height), MinimumSize = new Size(0, font.Height) };

            _install = new Button { Text = plan.ButtonText, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(font.Height * 6, 0), Margin = new Padding(0, 0, gap, 0), Enabled = plan.IsUpdate && !plan.IsBlocked };
            _cancel = new Button { Text = "Cancel", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(font.Height * 6, 0), Margin = new Padding(0) };

            var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Anchor = AnchorStyles.Right, Margin = new Padding(0), WrapContents = false };
            buttons.Controls.Add(_install);
            buttons.Controls.Add(_cancel);

            var layout = new TableLayoutPanel { ColumnCount = 1, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Fill };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, width));
            foreach (Control c in new Control[] { _heading, _intro, _folderLabel, _folderRow, _status, _startAfter, _progress, buttons })
            {
                layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                layout.Controls.Add(c);
            }

            Controls.Add(layout);

            // Tab order top to bottom: the label (its accelerator moves to the field), field, Browse, box, Install, Cancel.
            _folderLabel.TabIndex = 0;
            _folder.TabIndex = 1;
            _browse.TabIndex = 2;
            _startAfter.TabIndex = 3;
            _install.TabIndex = 4;
            _cancel.TabIndex = 5;
            AcceptButton = _install;

            _debounce = new Timer { Interval = DebounceMilliseconds };
            _debounce.Tick += (s, e) => EvaluateNow();

            // A screen reader hears the status line (where files go, or why the folder cannot be used) with the field.
            _folder.AccessibleDescription = _status.Text;
            _status.TextChanged += (s, e) => _folder.AccessibleDescription = _status.Text;

            _folder.TextChanged += OnFolderTextChanged;
            _folder.Leave += (s, e) => UseSubfolderText();
            _browse.Click += OnBrowse;
            _install.Click += OnInstallClicked;
            _cancel.Click += (s, e) => Close();

            // Started from a browser or Explorer, the window may open behind it.
            Shown += (s, e) => Activate();

            if (!plan.IsUpdate)
            {
                // The default folder is checked at once, off the UI thread.
                Shown += (s, e) => EvaluateNow();
            }
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            // Esc is Cancel, but not while files are being copied.
            if (keyData == Keys.Escape)
            {
                if (!_busy)
                {
                    Close();
                }

                return true;
            }

            return base.ProcessCmdKey(ref msg, keyData);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_busy && e.CloseReason != CloseReason.WindowsShutDown)
            {
                e.Cancel = true;
                MessageBox.Show(this, SetupTexts.StillCopying, Caption, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            base.OnFormClosing(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _debounce.Dispose();
            }

            base.Dispose(disposing);
        }

        // ---- the folder field ------------------------------------------------------------------------------

        private void OnFolderTextChanged(object? sender, EventArgs e)
        {
            if (_busy || _finished)
            {
                return;
            }

            // Until the new text has been checked, it cannot be installed into.
            _sequence++;
            _current = null;
            _install.Enabled = false;
            _status.Text = string.Empty;
            _debounce.Stop();
            _debounce.Start();
        }

        /// <summary>Checks the field's text with the folder rules on a worker thread; only the latest answer is shown.</summary>
        private void EvaluateNow()
        {
            _debounce.Stop();
            if (_busy || _finished || _plan.IsUpdate)
            {
                return;
            }

            string text = _folder.Text;
            int sequence = ++_sequence;
            // While typing nothing is written (probeWrite: false); pressing Install runs Installer.Install,
            // which checks the folder again with the write probe on.
            Task<InstallPathResult> work = Task.Run(() => InstallPathPolicy.Evaluate(text, _probe, _env, probeWrite: false));
            work.ContinueWith(t => UiCommon.PostToUi(this, () =>
            {
                if (sequence != _sequence || _busy || _finished)
                {
                    return;
                }

                // A faulted task rethrows here, on the UI thread, into the top-level handler.
                InstallPathResult result = t.Result;
                _current = result;
                _status.Text = result.Message;
                _install.Enabled = result.IsUsable;
            }));
        }

        /// <summary>
        /// When the folder rules chose the CyberPad subfolder, put that path in the field so the user sees
        /// exactly where files go. The new text is then checked again.
        /// </summary>
        private bool UseSubfolderText()
        {
            InstallPathResult? result = _current;
            if (!_plan.IsUpdate && !_busy && !_finished && result != null && result.IsUsable && result.Kind == InstallPathKind.UsesSubfolder && result.FullPath != null)
            {
                _folder.Text = result.FullPath;
                EvaluateNow();
                return true;
            }

            return false;
        }

        private void OnBrowse(object? sender, EventArgs e)
        {
            if (_busy)
            {
                return;
            }

            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Choose the folder to install CyberPad in.";
                dialog.ShowNewFolderButton = true;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    // Whatever the dialog returns goes through the same rules as typed text.
                    _folder.Text = dialog.SelectedPath;
                    EvaluateNow();
                }
            }
        }

        // ---- installing ------------------------------------------------------------------------------------

        private void OnInstallClicked(object? sender, EventArgs e)
        {
            if (_busy || _plan.IsBlocked)
            {
                return;
            }

            if (_finished)
            {
                Finish();
                return;
            }

            string folder;
            if (_plan.IsUpdate)
            {
                folder = _plan.Folder;
            }
            else
            {
                InstallPathResult? result = _current;
                if (result == null || !result.IsUsable || result.FullPath == null)
                {
                    return;
                }

                if (UseSubfolderText())
                {
                    // The field now shows where the files go; choose Install again to confirm.
                    return;
                }

                folder = result.FullPath;
            }

            RunInstall(folder);
        }

        private sealed class Outcome
        {
            public InstallResult? Result;
            public string? Failure;
            public Exception? Crash;
        }

        private async void RunInstall(string folder)
        {
            SetBusy(true);
            var progress = new Progress<int>(value => _progress.Value = Math.Max(0, Math.Min(100, value)));

            Outcome outcome = await Task.Run(() =>
            {
                var o = new Outcome();
                try
                {
                    using (Stream? payload = _assembly.GetManifestResourceStream(Program.PayloadResource))
                    using (Stream? uninstaller = _assembly.GetManifestResourceStream(Program.UninstallerResource))
                    {
                        if (payload == null || uninstaller == null)
                        {
                            throw new InstallException(SetupTexts.Incomplete);
                        }

                        var installer = new Installer(_registry, new StartMenuShortcuts(), new ShellNotify(), _probe, _env);
                        o.Result = installer.Install(new InstallRequest(folder, _version, payload, uninstaller), progress);
                    }
                }
                catch (InstallException ex)
                {
                    o.Failure = ex.Message;
                }
                catch (Exception ex)
                {
                    o.Crash = ex;
                }

                return o;
            });

            if (outcome.Crash != null)
            {
                UiCommon.Fail(SetupTexts.SetupProblem, outcome.Crash);
                return;
            }

            if (outcome.Result == null)
            {
                // The library has already undone this run's steps.
                SetBusy(false);
                string message = outcome.Failure ?? SetupTexts.SetupProblem;
                _status.Text = message;
                MessageBox.Show(this, message, Caption, MessageBoxButtons.OK, MessageBoxIcon.Error);
                EvaluateNow();
                return;
            }

            ShowDone(outcome.Result);
        }

        private void ShowDone(InstallResult result)
        {
            _finished = true;
            _busy = false;
            _installedDir = result.InstallDir;

            _heading.Text = result.WasUpdate ? SetupTexts.UpdatedDone : SetupTexts.InstalledDone;
            _intro.Visible = false;
            _folderLabel.Visible = false;
            _folderRow.Visible = false;
            _progress.Visible = false;
            _status.Text = result.InstallDir;
            _cancel.Visible = false;
            _startAfter.Enabled = true;
            _install.Text = "Finish";
            _install.Enabled = true;
            _install.Focus();
        }

        private void Finish()
        {
            string? dir = _installedDir;
            if (_startAfter.Checked && dir != null)
            {
                StartCyberPad(dir);
            }

            Close();
        }

        /// <summary>Starts the installed app by its full path, directly (no command shell), with no arguments.</summary>
        private void StartCyberPad(string installDir)
        {
            string exe = installDir + "\\" + InstallLayout.AppFileName;
            try
            {
                if (!File.Exists(exe))
                {
                    throw new FileNotFoundException();
                }

                var start = new ProcessStartInfo(exe)
                {
                    UseShellExecute = false,
                    WorkingDirectory = installDir,
                };
                using (Process.Start(start))
                {
                }
            }
            catch (Exception ex) when (ex is Win32Exception || ex is IOException || ex is InvalidOperationException || ex is SecurityException)
            {
                MessageBox.Show(this, SetupTexts.NotStarted, Caption, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            _folder.Enabled = !busy;
            _browse.Enabled = !busy && !_plan.IsUpdate;
            _startAfter.Enabled = !busy;
            _install.Enabled = !busy && !_plan.IsBlocked;
            _cancel.Enabled = !busy;
            _progress.Visible = busy;
            if (busy)
            {
                _progress.Value = 0;
                _debounce.Stop();
            }
        }
    }
}

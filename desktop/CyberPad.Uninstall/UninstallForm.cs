using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using CyberPad.Install;
using CyberPad.Install.UI;

namespace CyberPad.Uninstall
{
    /// <summary>The uninstall window (spec, "Uninstalling"). Lays out from the message font so it follows DPI scaling.</summary>
    internal sealed class UninstallForm : Form
    {
        private const string Caption = "Uninstall CyberPad";

        private readonly Install.Uninstaller _uninstaller;
        private readonly string _notesFolder;
        private readonly CheckBox _deleteNotes;
        private readonly Button _uninstall;
        private readonly Button _cancel;
        private bool _busy;

        public UninstallForm(Install.Uninstaller uninstaller, string notesFolder)
        {
            _uninstaller = uninstaller;
            _notesFolder = notesFolder;

            Font font = UiCommon.MessageFont;
            Font = font;
            AutoScaleMode = AutoScaleMode.None;
            Text = Caption;
            Icon = UiCommon.AppIcon();
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(font.Height);

            int width = UiCommon.ContentWidth(font);

            var heading = UiCommon.WrappingLabel("Remove CyberPad from this computer?", UiCommon.HeadingFont(font), width);
            var keep = UiCommon.WrappingLabel("Your notes are kept. They are in:", font, width);
            keep.Margin = new Padding(0, 0, 0, 0);
            var folder = UiCommon.WrappingLabel(notesFolder, font, width);
            folder.AccessibleName = "Notes folder";

            _deleteNotes = new CheckBox
            {
                Text = "&Also delete my notes and settings. This cannot be undone.",
                AutoSize = true,
                MaximumSize = new Size(width, 0),
                Margin = new Padding(0, 0, 0, font.Height),
                Checked = false,
            };

            _uninstall = new Button { Text = "&Uninstall", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(font.Height * 6, 0), Margin = new Padding(0, 0, font.Height / 2, 0) };
            _cancel = new Button { Text = "Cancel", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(font.Height * 6, 0), Margin = new Padding(0), DialogResult = DialogResult.Cancel };
            _uninstall.Click += OnUninstall;

            var buttons = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.LeftToRight,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Anchor = AnchorStyles.Right,
                Margin = new Padding(0),
                WrapContents = false,
            };
            buttons.Controls.Add(_uninstall);
            buttons.Controls.Add(_cancel);

            var layout = new TableLayoutPanel
            {
                ColumnCount = 1,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Dock = DockStyle.Fill,
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, width));
            foreach (Control c in new Control[] { heading, keep, folder, _deleteNotes, buttons })
            {
                layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                layout.Controls.Add(c);
            }

            Controls.Add(layout);

            // Tab order top to bottom: the checkbox, Uninstall, Cancel.
            _deleteNotes.TabIndex = 0;
            _uninstall.TabIndex = 1;
            _cancel.TabIndex = 2;
            AcceptButton = _uninstall;
            CancelButton = _cancel;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_busy && e.CloseReason != CloseReason.WindowsShutDown)
            {
                e.Cancel = true;
                return;
            }

            base.OnFormClosing(e);
        }

        private async void OnUninstall(object? sender, EventArgs e)
        {
            if (_busy)
            {
                return;
            }

            bool wantNotesDeleted = _deleteNotes.Checked;
            SetBusy(true);

            UninstallResult? result = null;
            string? failure = null;
            Exception? crash = null;
            await Task.Run(() =>
            {
                try
                {
                    result = _uninstaller.Uninstall();
                }
                catch (InstallException ex)
                {
                    failure = ex.Message;
                }
                catch (Exception ex)
                {
                    crash = ex;
                }
            });

            if (crash != null)
            {
                UiCommon.Fail(SetupTexts.UninstallProblem, crash);
                return;
            }

            if (failure != null || result == null)
            {
                SetBusy(false);
                UiCommon.Error(this, Caption, failure ?? SetupTexts.UninstallProblem);
                return;
            }

            string notesMessage = string.Empty;
            if (wantNotesDeleted && AskDeleteNotes())
            {
                string? notesFailure = null;
                NotesDeletionResult? notes = null;
                await Task.Run(() =>
                {
                    try
                    {
                        notes = _uninstaller.DeleteNotesFolder();
                    }
                    catch (InstallException ex)
                    {
                        notesFailure = ex.Message;
                    }
                    catch (Exception ex)
                    {
                        crash = ex;
                    }
                });

                if (crash != null)
                {
                    UiCommon.Fail(SetupTexts.UninstallProblem, crash);
                    return;
                }

                if (notesFailure != null)
                {
                    notesMessage = "\r\n\r\n" + notesFailure;
                }
                else if (notes != null && notes.NotDeleted.Count > 0)
                {
                    notesMessage = "\r\n\r\n" + SetupTexts.NotesLeftPrefix + notes.NotesFolder;
                }
            }

            SetBusy(false);
            UiCommon.Info(this, Caption, result.Message + notesMessage);
            Close();
        }

        private bool AskDeleteNotes()
        {
            using (var dialog = new DeleteNotesDialog(SetupTexts.DeleteNotesQuestion(_notesFolder)))
            {
                return dialog.ShowDialog(this) == DialogResult.Yes;
            }
        }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            Enabled = !busy;
        }
    }

    /// <summary>The second question: Delete notes or Keep notes, with Keep notes as the default button.</summary>
    internal sealed class DeleteNotesDialog : Form
    {
        public DeleteNotesDialog(string question)
        {
            Font font = UiCommon.MessageFont;
            Font = font;
            AutoScaleMode = AutoScaleMode.None;
            Text = "Uninstall CyberPad";
            Icon = UiCommon.AppIcon();
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterParent;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(font.Height);

            int width = UiCommon.ContentWidth(font);
            var text = UiCommon.WrappingLabel(question, font, width);
            text.Margin = new Padding(0, 0, 0, font.Height);

            var delete = new Button { Text = "&Delete notes", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(font.Height * 7, 0), Margin = new Padding(0, 0, font.Height / 2, 0), DialogResult = DialogResult.Yes };
            var keep = new Button { Text = "&Keep notes", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(font.Height * 7, 0), Margin = new Padding(0), DialogResult = DialogResult.No };

            var buttons = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.LeftToRight,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Anchor = AnchorStyles.Right,
                Margin = new Padding(0),
                WrapContents = false,
            };
            buttons.Controls.Add(delete);
            buttons.Controls.Add(keep);

            var layout = new TableLayoutPanel { ColumnCount = 1, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Fill };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, width));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(text);
            layout.Controls.Add(buttons);
            Controls.Add(layout);

            delete.TabIndex = 0;
            keep.TabIndex = 1;
            // The safe answer is the default: Enter and Esc both keep the notes.
            AcceptButton = keep;
            CancelButton = keep;
            ActiveControl = keep;
        }
    }
}

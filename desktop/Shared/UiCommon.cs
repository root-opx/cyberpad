using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
using CyberPad.Install;

namespace CyberPad.Install.UI
{
    /// <summary>Small helpers shared by Setup and Uninstall (linked into both projects).</summary>
    internal static class UiCommon
    {
        /// <summary>The Windows message font, so text follows the user's display settings.</summary>
        public static Font MessageFont => SystemFonts.MessageBoxFont ?? SystemFonts.DefaultFont;

        public static Font HeadingFont(Font basis) => new Font(basis.FontFamily, basis.SizeInPoints * 1.35f, FontStyle.Bold, GraphicsUnit.Point);

        /// <summary>Width of the content column, derived from the font so it follows the DPI scale.</summary>
        public static int ContentWidth(Font font) => font.Height * 30;

        public static Icon? AppIcon()
        {
            try
            {
                return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception ex) when (ex is ArgumentException || ex is System.IO.IOException || ex is UnauthorizedAccessException)
            {
                return null;
            }
        }

        /// <summary>
        /// Starts the message loop's safety net: any unhandled exception shows one sentence and the exception
        /// type name (never a stack trace) and ends the program.
        /// </summary>
        public static void InstallExceptionHandlers(string problemText)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) => Fail(problemText, e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Fail(problemText, e.ExceptionObject as Exception);
        }

        private static int _failing;

        public static void Fail(string problemText, Exception? ex)
        {
            if (Interlocked.Exchange(ref _failing, 1) == 0)
            {
                try
                {
                    string type = ex == null ? "Error type: unknown" : SetupTexts.ErrorTypeLine(ex);
                    MessageBox.Show(problemText + "\r\n\r\n" + type, "CyberPad", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally
                {
                    Environment.Exit(1);
                }
            }
        }

        public static void Info(IWin32Window? owner, string title, string text) =>
            MessageBox.Show(owner, text, title, MessageBoxButtons.OK, MessageBoxIcon.Information);

        public static void Error(IWin32Window? owner, string title, string text) =>
            MessageBox.Show(owner, text, title, MessageBoxButtons.OK, MessageBoxIcon.Error);

        /// <summary>Runs <paramref name="action"/> later on the form's UI thread; does nothing once the form is gone.</summary>
        public static void PostToUi(Form form, Action action)
        {
            try
            {
                if (!form.IsDisposed && form.IsHandleCreated)
                {
                    form.BeginInvoke(action);
                }
            }
            catch (InvalidOperationException)
            {
                // The window closed while the work was running.
            }
        }

        public static Label WrappingLabel(string text, Font font, int width) => new Label
        {
            Text = text,
            Font = font,
            AutoSize = true,
            MaximumSize = new Size(width, 0),
            Margin = new Padding(0, 0, 0, font.Height / 2),
            UseMnemonic = false,
        };
    }
}

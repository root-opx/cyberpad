using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Windows.Forms;
using CyberPad.Install;
using CyberPad.Install.UI;

namespace CyberPad.Uninstall
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            // The library is embedded; its loader must be in place before any library type is touched.
            EmbeddedLibrary.Register();
            return Run(args);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static int Run(string[] args)
        {
            UiCommon.InstallExceptionHandlers(SetupTexts.UninstallProblem);

            switch (UninstallStages.Parse(args))
            {
                case UninstallStage.First:
                    return FirstStage();
                case UninstallStage.Second:
                    return SecondStage();
                default:
                    // Any other argument, or more than one: do nothing.
                    return 2;
            }
        }

        /// <summary>
        /// Started from the install folder. Checks there is an install, copies this program to the temp
        /// folder (it cannot delete itself while running) and starts the copy. The only argument handed
        /// over is the fixed word --stage2; no path is passed.
        /// </summary>
        private static int FirstStage()
        {
            try
            {
                InstallEnvironment env = InstallEnvironment.FromSystem();
                if (Installer.FindExisting(new WindowsRegistry(), new FileSystemProbe(), env) == null)
                {
                    UiCommon.Info(null, "Uninstall CyberPad", SetupTexts.NotInstalledForAccount);
                    return 0;
                }

                string copy = CopyToTemp(env.Temp);
                try
                {
                    // Started by its full path, directly: no command shell.
                    var start = new ProcessStartInfo(copy, UninstallStages.Stage2Argument)
                    {
                        UseShellExecute = false,
                        WorkingDirectory = env.Temp,
                    };
                    using (Process.Start(start))
                    {
                    }
                }
                catch (Win32Exception)
                {
                    TryDelete(copy);
                    throw;
                }

                return 0;
            }
            catch (InstallException ex)
            {
                UiCommon.Error(null, "Uninstall CyberPad", ex.Message);
                return 1;
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is Win32Exception)
            {
                UiCommon.Error(null, "Uninstall CyberPad", SetupTexts.UninstallProblem);
                return 1;
            }
        }

        /// <summary>
        /// Started as the temp copy. It never trusts where it was started from: the install is found only
        /// through the registry entry and the manifest check in the library.
        /// </summary>
        private static int SecondStage()
        {
            InstallEnvironment env;
            try
            {
                env = InstallEnvironment.FromSystem();
            }
            catch (InstallException ex)
            {
                UiCommon.Error(null, "Uninstall CyberPad", ex.Message);
                return 1;
            }

            var registry = new WindowsRegistry();
            var probe = new FileSystemProbe();
            if (Installer.FindExisting(registry, probe, env) == null)
            {
                UiCommon.Info(null, "Uninstall CyberPad", SetupTexts.NotInstalledForAccount);
                return 0;
            }

            var uninstaller = new Install.Uninstaller(registry, new StartMenuShortcuts(), new ShellNotify(), probe, env);
            Application.Run(new UninstallForm(uninstaller, env.NotesFolder));
            return 0;
        }

        private static string CopyToTemp(string tempFolder)
        {
            string self = Application.ExecutablePath;
            var random = new byte[UninstallStages.RandomBytes];
            using (var rng = new RNGCryptoServiceProvider())
            {
                rng.GetBytes(random);
            }

            string target = UninstallStages.TempCopyPath(tempFolder, random);
            // CreateNew: never overwrites or follows anything already at that name; if it fails, nothing of ours exists to clean up.
            using (var destination = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                try
                {
                    using (var source = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        source.CopyTo(destination);
                    }
                }
                catch
                {
                    destination.Dispose();
                    TryDelete(target);
                    throw;
                }
            }

            return target;
        }

        private static void TryDelete(string file)
        {
            try
            {
                File.Delete(file);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                // Best effort; a stray copy in temp is harmless.
            }
        }
    }
}

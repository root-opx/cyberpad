using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Windows.Forms;
using CyberPad.Install;
using CyberPad.Install.UI;

namespace CyberPad.Uninstall
{
    internal static class Program
    {
        private const string Caption = "Uninstall CyberPad";
        private const int MaxOldCopies = 1000;

        [STAThread]
        private static int Main(string[] args)
        {
            // The library's code is compiled into this exe; no DLL is loaded from beside it.
            UiCommon.InstallExceptionHandlers(SetupTexts.UninstallProblem);

            UninstallStage stage = UninstallStages.Parse(args);
            if (stage == UninstallStage.Invalid)
            {
                return 2; // any other argument, or more than one: do nothing
            }

            if (ProcessGuard.IsElevated())
            {
                UiCommon.Error(null, Caption, SetupTexts.UninstallElevated);
                return 1;
            }

            return stage == UninstallStage.First ? FirstStage() : SecondStage();
        }

        /// <summary>
        /// Started from the install folder. Checks there is an install, copies this program to the temp
        /// folder (it cannot delete itself while running) and starts the copy. The only argument handed
        /// over is the fixed word --stage2; no path is passed. The single-instance mutex is held until the
        /// copy has started; the copy waits for it to be released.
        /// </summary>
        private static int FirstStage()
        {
            using (SingleInstance? instance = SingleInstance.TryTake(0))
            {
                if (instance == null)
                {
                    UiCommon.Info(null, Caption, SetupTexts.AlreadyRunning);
                    return 1;
                }

                InstallEnvironment env;
                try
                {
                    env = InstallEnvironment.FromSystem();

                    // The entry alone is enough: when its file list is missing, uninstall still removes the
                    // entry and the shortcut (and deletes no file).
                    if (!Installer.HasUninstallEntry(new WindowsRegistry()))
                    {
                        UiCommon.Info(null, Caption, SetupTexts.NotInstalledForAccount);
                        return 0;
                    }
                }
                catch (InstallException ex)
                {
                    UiCommon.Error(null, Caption, ex.Message);
                    return 1;
                }

                string copy;
                FileStream readHandle;
                try
                {
                    copy = CopyToTemp(env.Temp, out readHandle);
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is SecurityException ||
                                           ex is ArgumentException || ex is NotSupportedException || ex is InvalidOperationException ||
                                           ex is IdentityNotMappedException)
                {
                    UiCommon.Error(null, Caption, SetupTexts.TempCopyFailed);
                    return 1;
                }

                // The read-only handle (shared for reading only) keeps anyone from changing the copy until
                // Windows has opened it to start it.
                using (readHandle)
                {
                    try
                    {
                        // Started by its full path, directly: no command shell.
                        var start = new ProcessStartInfo(copy, UninstallStages.Stage2Argument)
                        {
                            UseShellExecute = false,
                            WorkingDirectory = env.Temp,
                        };
                        using (Process? process = Process.Start(start))
                        {
                            if (process != null)
                            {
                                // Lets the uninstall window come to the front even though Settings has the focus.
                                _ = AllowSetForegroundWindow(process.Id); // best effort; the window also activates itself
                            }
                        }
                    }
                    catch (Exception ex) when (ex is Win32Exception || ex is InvalidOperationException || ex is IOException)
                    {
                        readHandle.Dispose();
                        TryDelete(copy);
                        UiCommon.Error(null, Caption, SetupTexts.UninstallProblem);
                        return 1;
                    }
                }

                return 0;
            }
        }

        /// <summary>
        /// Started as the temp copy. It never trusts where it was started from: the install is found only
        /// through the registry entry and the manifest check in the library.
        /// </summary>
        private static int SecondStage()
        {
            // The first stage releases the mutex right after starting this copy.
            using (SingleInstance? instance = SingleInstance.TryTake(UninstallStages.SecondStageWaitMilliseconds))
            {
                if (instance == null)
                {
                    UiCommon.Info(null, Caption, SetupTexts.AlreadyRunning);
                    return 1;
                }

                InstallEnvironment env;
                var registry = new WindowsRegistry();
                var probe = new FileSystemProbe();
                try
                {
                    env = InstallEnvironment.FromSystem();
                    DeleteOlderCopies(env.Temp);
                    if (!Installer.HasUninstallEntry(registry))
                    {
                        UiCommon.Info(null, Caption, SetupTexts.NotInstalledForAccount);
                        return 0;
                    }
                }
                catch (InstallException ex)
                {
                    UiCommon.Error(null, Caption, ex.Message);
                    return 1;
                }

                var uninstaller = new Install.Uninstaller(registry, new StartMenuShortcuts(), new ShellNotify(), probe, env);
                Application.Run(new UninstallForm(uninstaller, env.NotesFolder));
                return 0;
            }
        }

        /// <summary>
        /// Copies this program to <c>CyberPad-Uninstall-&lt;random&gt;.exe</c> in the temp folder. The file is
        /// created new with a protected access list (this user, SYSTEM and Administrators only, nothing
        /// inherited), then reopened for reading with read-only sharing; that handle is returned.
        /// </summary>
        private static string CopyToTemp(string tempFolder, out FileStream readHandle)
        {
            string self = Application.ExecutablePath;
            var random = new byte[UninstallStages.RandomBytes];
            using (var rng = new RNGCryptoServiceProvider())
            {
                rng.GetBytes(random);
            }

            string target = UninstallStages.TempCopyPath(tempFolder, random);
            FileSecurity security = OwnerOnlySecurity();
            bool created = false;
            try
            {
                // CreateNew: never overwrites or follows anything already at that name.
                using (var destination = new FileStream(target, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, security))
                {
                    created = true;
                    using (var source = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        source.CopyTo(destination);
                    }
                }

                // Fail closed: the copy is started only if its access list really is the protected one.
                if (!File.GetAccessControl(target).AreAccessRulesProtected)
                {
                    throw new InvalidOperationException("The temporary copy's access list was not applied.");
                }

                readHandle = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read);
                return target;
            }
            catch
            {
                if (created)
                {
                    TryDelete(target);
                }

                throw;
            }
        }

        private static FileSecurity OwnerOnlySecurity()
        {
            SecurityIdentifier user = WindowsIdentity.GetCurrent().User
                ?? throw new InvalidOperationException("The current user has no security identifier.");
            var security = new FileSecurity();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            foreach (SecurityIdentifier sid in new[]
            {
                user,
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            })
            {
                security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
            }

            return security;
        }

        /// <summary>
        /// Deletes copies earlier uninstalls left in the temp folder: regular files named exactly
        /// <c>CyberPad-Uninstall-&lt;32 hex digits&gt;.exe</c>, never this one, never a link. Failures are ignored.
        /// </summary>
        private static void DeleteOlderCopies(string tempFolder)
        {
            string own = Path.GetFileName(Application.ExecutablePath);
            string[] candidates;
            try
            {
                candidates = Directory.EnumerateFiles(tempFolder, UninstallStages.TempPrefix + "*" + UninstallStages.TempExtension)
                    .Take(MaxOldCopies)
                    .ToArray();
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is SecurityException)
            {
                return;
            }

            foreach (string path in candidates)
            {
                string name = Path.GetFileName(path);
                if (!UninstallStages.IsTempCopyName(name) || string.Equals(name, own, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string file = Path.Combine(tempFolder, name);
                try
                {
                    FileAttributes attributes = File.GetAttributes(file);
                    if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0)
                    {
                        File.Delete(file);
                    }
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is SecurityException)
                {
                    // Still running, or not ours to delete: left for a later uninstall.
                }
            }
        }

        private static void TryDelete(string file)
        {
            try
            {
                File.Delete(file);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                // Best effort; a stray copy in temp is harmless and the next uninstall removes it.
            }
        }

        [DllImport("user32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AllowSetForegroundWindow(int processId);
    }
}

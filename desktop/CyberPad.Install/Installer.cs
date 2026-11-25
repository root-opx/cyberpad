using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security;

namespace CyberPad.Install
{
    public sealed class InstallRequest
    {
        public InstallRequest(string installDir, string version, Stream payload, Stream uninstaller)
        {
            InstallDir = installDir ?? throw new ArgumentNullException(nameof(installDir));
            Version = version ?? throw new ArgumentNullException(nameof(version));
            Payload = payload ?? throw new ArgumentNullException(nameof(payload));
            Uninstaller = uninstaller ?? throw new ArgumentNullException(nameof(uninstaller));
        }

        /// <summary>The folder to install into, as shown in the field (normally <see cref="InstallPathResult.FullPath"/>).</summary>
        public string InstallDir { get; }

        public string Version { get; }

        /// <summary>The zip of program files.</summary>
        public Stream Payload { get; }

        /// <summary>The bytes of <c>Uninstall.exe</c>.</summary>
        public Stream Uninstaller { get; }
    }

    public sealed class InstallResult
    {
        internal InstallResult(string installDir, bool wasUpdate, IReadOnlyList<string> leftovers)
        {
            InstallDir = installDir;
            WasUpdate = wasUpdate;
            Leftovers = leftovers;
        }

        public string InstallDir { get; }

        public bool WasUpdate { get; }

        /// <summary>Backup copies of replaced files that could not be cleaned up (rare; harmless).</summary>
        public IReadOnlyList<string> Leftovers { get; }

        public string Message => InstallMessages.Installed;
    }

    public sealed class ExistingInstall
    {
        internal ExistingInstall(string installDir, InstallManifest manifest)
        {
            InstallDir = installDir;
            Manifest = manifest;
        }

        public string InstallDir { get; }

        public InstallManifest Manifest { get; }

        public string Version => Manifest.Version;
    }

    /// <summary>The ordered install steps, for tests that inject a failure at one of them.</summary>
    internal enum InstallStep
    {
        CheckRunning,
        ReadOldManifest,
        Payload,
        Uninstaller,
        Manifest,
        RemoveOldFiles,
        Shortcut,
        Registry,
        Notify,
    }

    /// <summary>Installs or updates CyberPad (spec, "What installing does, in order"), undoing the run on failure.</summary>
    public sealed class Installer
    {
        public const long MaxUninstallerBytes = 64L * 1024 * 1024;

        private readonly IRegistry _registry;
        private readonly IShortcuts _shortcuts;
        private readonly IShellNotify _notify;
        private readonly IFileSystemProbe _probe;
        private readonly InstallEnvironment _env;

        public Installer(IRegistry registry, IShortcuts shortcuts, IShellNotify notify, IFileSystemProbe probe, InstallEnvironment env)
        {
            _registry = registry ?? throw new ArgumentNullException(nameof(registry));
            _shortcuts = shortcuts ?? throw new ArgumentNullException(nameof(shortcuts));
            _notify = notify ?? throw new ArgumentNullException(nameof(notify));
            _probe = probe ?? throw new ArgumentNullException(nameof(probe));
            _env = env ?? throw new ArgumentNullException(nameof(env));
        }

        /// <summary>The extractor to use; tests inject one with small caps.</summary>
        internal PayloadExtractor Extractor { get; set; } = new PayloadExtractor();

        /// <summary>Called as each step starts; tests throw from it to inject a failure.</summary>
        internal Action<InstallStep>? StepStarting { get; set; }

        /// <summary>
        /// Finds the current install through its uninstall entry. The folder is accepted only if it passes
        /// the folder rules as an existing install with a valid manifest; otherwise null.
        /// </summary>
        public static ExistingInstall? FindExisting(IRegistry registry, IFileSystemProbe probe, InstallEnvironment env)
        {
            object? location = Guard(InstallMessages.RegistryReadFailed, () => registry.GetValue(RegistryKeyId.UninstallEntry, "InstallLocation"));
            if (!(location is string text))
            {
                return null;
            }

            // Finding an install writes nothing; installing re-checks with the write probe on.
            InstallPathResult result = InstallPathPolicy.Evaluate(text, probe, env, probeWrite: false);
            if (!result.IsUsable || result.Kind != InstallPathKind.ExistingInstall || result.FullPath == null)
            {
                return null;
            }

            InstallManifest? manifest = InstallManifest.TryReadFrom(result.FullPath, probe);
            return manifest == null ? null : new ExistingInstall(result.FullPath, manifest);
        }

        public InstallResult Install(InstallRequest request, IProgress<int>? progress)
        {
            if (request == null)
            {
                throw new ArgumentNullException(nameof(request));
            }

            if (!InstallManifest.IsValidVersion(request.Version))
            {
                throw new ArgumentException("The version must be digits separated by dots.", nameof(request));
            }

            InstallPathResult path = InstallPathPolicy.Evaluate(request.InstallDir, _probe, _env, probeWrite: true);
            if (!path.IsUsable || path.FullPath == null)
            {
                throw new InstallException(path.Message);
            }

            // Setup installs exactly where the window said. The window puts the CyberPad subfolder in the field
            // before Install; if the rules now pick a subfolder, the folder changed after it was checked.
            if (path.Kind == InstallPathKind.UsesSubfolder)
            {
                throw new InstallException(InstallMessages.FolderChanged);
            }

            string dir = path.FullPath;
            bool isUpdate = path.FolderKind == InstallPathKind.ExistingInstall;
            string exe = dir + "\\" + InstallLayout.AppFileName;

            // Build the command strings first: they reject a folder that cannot be quoted safely.
            string uninstallCommand = CommandLine.UninstallCommand(dir);
            string openCommand = CommandLine.OpenCommand(dir);

            // 2. The old file list, when updating (read first: step 1 needs to know whether CyberPad.exe is ours).
            Step(InstallStep.ReadOldManifest);
            InstallManifest? old = null;
            if (isUpdate)
            {
                old = InstallManifest.TryReadFrom(dir, _probe) ?? throw new InstallException(InstallMessages.FilesInTheWay);

                // Never replace a newer install with an older version; the same version reinstalls.
                if (InstallManifest.CompareVersions(request.Version, old.Version) < 0)
                {
                    throw new InstallException(InstallMessages.NewerInstalled(old.Version));
                }
            }

            // 1. CyberPad must not be running from the target folder.
            Step(InstallStep.CheckRunning);
            bool appIsOurs = old != null && old.Files.Any(f => PathText.AreSame(f, InstallLayout.AppFileName));
            CheckAppReplaceable(_probe, exe, appIsOurs, isUpdate ? InstallMessages.CloseToUpdate : InstallMessages.CloseToInstall, InstallMessages.CannotReplaceApp);

            var replaceable = new List<string>();
            if (old != null)
            {
                replaceable.AddRange(old.Files);
                replaceable.Add(InstallManifest.FileName);
                replaceable.Add(InstallLayout.UninstallerFileName);
            }

            var run = new Run(new FileJournal(dir, _probe, replaceable) { CommitStep = JournalCommitStep });
            bool finished = false;
            InstallResult? result = null;
            try
            {
                run.Journal.EnsureInstallDirectory();

                // 3. The payload.
                Step(InstallStep.Payload);
                PayloadExtraction extraction = Extractor.Extract(request.Payload, run.Journal, new ScaledProgress(progress, 90));
                if (!extraction.Files.Any(f => PathText.AreSame(f, InstallLayout.AppFileName)))
                {
                    throw new InstallException(InstallMessages.PayloadDamaged);
                }

                // 4. Uninstall.exe and the manifest.
                Step(InstallStep.Uninstaller);
                long uninstallerBytes = WriteUninstaller(request.Uninstaller, run.Journal);

                Step(InstallStep.Manifest);
                var manifest = new InstallManifest(request.Version, extraction.Files);
                byte[] manifestBytes = manifest.ToBytes();
                using (Stream stream = run.Journal.CreateFile(InstallManifest.FileName, out _))
                {
                    Guard(InstallMessages.WriteFailed, () =>
                    {
                        stream.Write(manifestBytes, 0, manifestBytes.Length);
                        return true;
                    });
                }

                progress?.Report(95);

                // 5. Files the old version had and the new one does not.
                Step(InstallStep.RemoveOldFiles);
                if (old != null)
                {
                    var current = new HashSet<string>(extraction.Files, StringComparer.OrdinalIgnoreCase);
                    foreach (string file in old.Files.Where(f => !current.Contains(f)))
                    {
                        run.Journal.RemoveOldFile(file);
                    }
                }

                // 6. The Start menu shortcut.
                Step(InstallStep.Shortcut);
                run.ShortcutBefore = TryReadShortcut(_shortcuts); // an unreadable shortcut is treated as absent and overwritten
                run.ShortcutTouched = true;
                Guard(InstallMessages.ShortcutFailed, () =>
                {
                    _shortcuts.Create(new ShortcutInfo(exe, dir, exe));
                    return true;
                });

                // 7. The registry.
                Step(InstallStep.Registry);
                run.RegistryBefore = Guard(InstallMessages.RegistryFailed, () => RegistrySnapshot.Take(_registry));

                // An "Open with" entry that existed before the first install is remembered so uninstall can put
                // it back; an update (the entry exists) keeps the record the first install saved.
                OpenWithRegistration openWithBefore = Guard(
                    InstallMessages.RegistryFailed,
                    () => _registry.KeyExists(RegistryKeyId.UninstallEntry) ? OpenWithRegistration.ReadSaved(_registry) : OpenWithRegistration.Capture(_registry));
                long totalBytes = extraction.TotalBytes + uninstallerBytes + manifestBytes.Length;
                Guard(InstallMessages.RegistryFailed, () =>
                {
                    WriteRegistry(request.Version, dir, exe, uninstallCommand, openCommand, totalBytes);
                    openWithBefore.Save(_registry);
                    return true;
                });

                // 8. Tell Explorer.
                Step(InstallStep.Notify);
                Guard(InstallMessages.NotifyFailed, () =>
                {
                    _notify.AssociationsChanged();
                    return true;
                });

                // From here the new install is complete and stays: Commit never throws and nothing is undone.
                run.Committed = true;
                IReadOnlyList<string> leftovers = run.Journal.Commit();
                finished = true;
                result = new InstallResult(dir, isUpdate, leftovers);
            }
            catch (InstallException ex)
            {
                run.Undone = true;
                if (run.Committed)
                {
                    // Nothing is undone once the commit has started, so never say it was.
                    throw new InstallException(InstallMessages.InstalledCleanupIncomplete, ex);
                }

                if (!Undo(run))
                {
                    throw new InstallException(InstallMessages.UndoIncomplete, ex);
                }

                throw;
            }
            catch (Exception ex) when (!CriticalExceptions.IsCritical(ex))
            {
                // Any other failure is undone and reported with a safe message; it is not swallowed.
                run.Undone = true;
                if (run.Committed)
                {
                    throw new InstallException(InstallMessages.InstalledCleanupIncomplete, ex);
                }

                throw new InstallException(Undo(run) ? InstallMessages.UnexpectedFailure : InstallMessages.UndoIncomplete, ex);
            }
            finally
            {
                if (!finished && !run.Undone)
                {
                    Undo(run);
                }
            }

            // Outside the try: the install is complete, so a throwing progress callback cannot undo it.
            try
            {
                progress?.Report(100);
            }
            catch (Exception ex) when (!CriticalExceptions.IsCritical(ex))
            {
                throw new InstallException(InstallMessages.InstalledCleanupIncomplete, ex);
            }

            return result!;
        }

        /// <summary>Called before each clean-up step of the final commit; tests throw from it.</summary>
        internal Action<string>? JournalCommitStep { get; set; }

        /// <summary>
        /// Whether CyberPad is registered for this user at all (the uninstall entry exists), even when its
        /// folder or file list is no longer valid.
        /// </summary>
        public static bool HasUninstallEntry(IRegistry registry) =>
            Guard(InstallMessages.RegistryReadFailed, () => registry.KeyExists(RegistryKeyId.UninstallEntry));

        /// <summary>
        /// Stops when CyberPad.exe is running (a sharing violation). When it is only read-only and is a file
        /// the install wrote (listed in its manifest), the read-only attribute is cleared and the check repeated.
        /// </summary>
        internal static void CheckAppReplaceable(IFileSystemProbe probe, string exe, bool listedInManifest, string runningMessage, string deniedMessage)
        {
            if (!probe.FileExists(exe))
            {
                return;
            }

            FileWriteCheck check = probe.CheckWritable(exe);
            if (check == FileWriteCheck.Denied && listedInManifest && !probe.IsReparsePoint(exe) && ClearReadOnly(exe))
            {
                check = probe.CheckWritable(exe);
            }

            if (check == FileWriteCheck.InUse)
            {
                throw new InstallException(runningMessage);
            }

            if (check == FileWriteCheck.Denied)
            {
                throw new InstallException(deniedMessage);
            }
        }

        /// <summary>Clears the read-only attribute of a file inside a validated install folder. False if it could not.</summary>
        internal static bool ClearReadOnly(string file)
        {
            try
            {
                FileAttributes attributes = File.GetAttributes(file);
                if ((attributes & FileAttributes.ReadOnly) == 0)
                {
                    return false;
                }

                File.SetAttributes(file, attributes & ~FileAttributes.ReadOnly);
                return true;
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
            catch (SecurityException)
            {
                return false;
            }
        }

        /// <summary>The current shortcut; one that cannot be read, whatever the reason, is treated as absent and overwritten.</summary>
        private static ShortcutInfo? TryReadShortcut(IShortcuts shortcuts)
        {
            try
            {
                return shortcuts.TryRead();
            }
            catch (Exception ex) when (!CriticalExceptions.IsCritical(ex))
            {
                return null;
            }
        }

        private void Step(InstallStep step) => StepStarting?.Invoke(step);

        private static long WriteUninstaller(Stream source, FileJournal journal)
        {
            Stream target = journal.CreateFile(InstallLayout.UninstallerFileName, out string fullPath);
            bool complete = false;
            long total = 0;
            try
            {
                var buffer = new byte[81920];
                while (true)
                {
                    int read = Guard(InstallMessages.PayloadDamaged, () => source.Read(buffer, 0, buffer.Length));
                    if (read == 0)
                    {
                        break;
                    }

                    total += read;
                    if (total > MaxUninstallerBytes)
                    {
                        throw new InstallException(InstallMessages.PayloadDamaged);
                    }

                    Guard(InstallMessages.WriteFailed, () =>
                    {
                        target.Write(buffer, 0, read);
                        return true;
                    });
                }

                if (total == 0)
                {
                    throw new InstallException(InstallMessages.PayloadDamaged);
                }

                complete = true;
                return total;
            }
            finally
            {
                target.Dispose();
                if (!complete)
                {
                    journal.DiscardCreatedFile(fullPath);
                }
            }
        }

        private void WriteRegistry(string version, string dir, string exe, string uninstallCommand, string openCommand, long totalBytes)
        {
            long kilobytes = (totalBytes + 1023) / 1024;
            int estimatedSize = kilobytes > int.MaxValue ? int.MaxValue : (int)kilobytes;

            _registry.SetString(RegistryKeyId.UninstallEntry, "DisplayName", InstallLayout.DisplayName);
            _registry.SetString(RegistryKeyId.UninstallEntry, "DisplayVersion", version);
            _registry.SetString(RegistryKeyId.UninstallEntry, "Publisher", InstallLayout.Publisher);
            _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", dir);
            _registry.SetString(RegistryKeyId.UninstallEntry, "DisplayIcon", exe);
            _registry.SetString(RegistryKeyId.UninstallEntry, "UninstallString", uninstallCommand);
            _registry.SetDword(RegistryKeyId.UninstallEntry, "NoModify", 1);
            _registry.SetDword(RegistryKeyId.UninstallEntry, "NoRepair", 1);
            _registry.SetDword(RegistryKeyId.UninstallEntry, "EstimatedSize", estimatedSize);

            _registry.SetString(RegistryKeyId.OpenWithApplication, "FriendlyAppName", InstallLayout.DisplayName);
            _registry.SetString(RegistryKeyId.OpenWithCommand, string.Empty, openCommand);
            foreach (string type in InstallLayout.OpenWithTypes)
            {
                _registry.SetString(RegistryKeyId.OpenWithSupportedTypes, type, string.Empty);
            }
        }

        /// <summary>Undoes the run in reverse order. Returns false when something could not be undone.</summary>
        private bool Undo(Run run)
        {
            if (run.Committed)
            {
                return true; // the new install is complete; undoing it now would destroy it
            }

            bool complete = true;
            if (run.RegistryBefore != null)
            {
                complete &= TryUndo(() => run.RegistryBefore.Restore(_registry));
            }

            if (run.ShortcutTouched)
            {
                complete &= TryUndo(() =>
                {
                    if (run.ShortcutBefore != null)
                    {
                        _shortcuts.Create(run.ShortcutBefore);
                    }
                    else
                    {
                        _shortcuts.Delete();
                    }
                });
            }

            complete &= run.Journal.Rollback();
            return complete;
        }

        private static bool TryUndo(Action action)
        {
            try
            {
                action();
                return true;
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
            catch (SecurityException)
            {
                return false;
            }
            catch (InstallException)
            {
                return false;
            }
        }

        /// <summary>Runs a step, converting the expected system errors into the step's user-safe message.</summary>
        private static T Guard<T>(string message, Func<T> action)
        {
            try
            {
                return action();
            }
            catch (IOException ex)
            {
                throw new InstallException(message, ex);
            }
            catch (UnauthorizedAccessException ex)
            {
                throw new InstallException(message, ex);
            }
            catch (SecurityException ex)
            {
                throw new InstallException(message, ex);
            }
        }

        private sealed class Run
        {
            public Run(FileJournal journal)
            {
                Journal = journal;
            }

            public FileJournal Journal { get; }

            public ShortcutInfo? ShortcutBefore { get; set; }

            public bool ShortcutTouched { get; set; }

            public RegistrySnapshot? RegistryBefore { get; set; }

            public bool Undone { get; set; }

            public bool Committed { get; set; }
        }

        /// <summary>Maps 0–100 onto 0–<c>max</c>, reporting synchronously.</summary>
        private sealed class ScaledProgress : IProgress<int>
        {
            private readonly IProgress<int>? _inner;
            private readonly int _max;

            public ScaledProgress(IProgress<int>? inner, int max)
            {
                _inner = inner;
                _max = max;
            }

            public void Report(int value) => _inner?.Report(value * _max / 100);
        }
    }
}

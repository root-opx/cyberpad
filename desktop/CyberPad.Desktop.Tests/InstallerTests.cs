using System.Text;
using CyberPad.Install;

namespace CyberPad.Desktop.Tests;

/// <summary>Installs into a temp folder with fake registry, shortcut and notify; nothing real is touched.</summary>
[Collection(InstallTestCollection.Name)]
public sealed class InstallerTests : IDisposable
{
    private readonly InstallTempDir _temp = new();
    private readonly InstallEnvironment _env;
    private readonly FakeRegistry _registry = new();
    private readonly FakeShortcuts _shortcuts = new();
    private readonly FakeNotify _notify = new();
    private readonly FileSystemProbe _probe = new();
    private readonly string _dir;
    private readonly string _victim;

    public InstallerTests()
    {
        _env = TestEnvironments.Under(_temp.Root);
        _dir = _env.DefaultInstallFolder;
        _victim = _temp.Path_("victim.txt");
        File.WriteAllText(_victim, "keep me");
    }

    public void Dispose()
    {
        Assert.Equal("keep me", File.ReadAllText(_victim)); // every test: the file outside is never touched
        _temp.Dispose();
    }

    internal static readonly (string, string)[] V1 =
    {
        ("CyberPad.exe", "app v1"),
        ("wwwroot/index.html", "index v1"),
        ("wwwroot/js/old.js", "old"),
        ("legacy/only-v1/data.bin", "legacy"),
    };

    internal static readonly (string, string)[] V2 =
    {
        ("CyberPad.exe", "app v2"),
        ("wwwroot/index.html", "index v2"),
        ("wwwroot/js/new.js", "new"),
    };

    private Installer NewInstaller() => new(_registry, _shortcuts, _notify, _probe, _env);

    private InstallResult Install((string, string)[] payload, string version, string? dir = null, Action<Installer>? setup = null, IProgress<int>? progress = null)
    {
        Installer installer = NewInstaller();
        setup?.Invoke(installer);
        using MemoryStream zip = TestZips.Build(payload);
        using var uninstaller = new MemoryStream(Encoding.UTF8.GetBytes("uninstaller " + version));
        return installer.Install(new InstallRequest(dir ?? _dir, version, zip, uninstaller), progress);
    }

    private string State() => _temp.Dump() + "\n--\n" + _registry.Dump() + "\n--\n" + _shortcuts.Dump();

    [Fact]
    public void FreshInstall_WritesFilesManifestShortcutAndRegistry()
    {
        var progress = new ListProgress();
        InstallResult result = Install(V1, "1.0.0", progress: progress);

        Assert.Equal(_dir, result.InstallDir);
        Assert.False(result.WasUpdate);
        Assert.Empty(result.Leftovers);
        Assert.Equal("CyberPad is installed.", result.Message);
        Assert.Equal(100, progress.Values.Last());

        Assert.Equal("app v1", File.ReadAllText(Path.Combine(_dir, "CyberPad.exe")));
        Assert.Equal("uninstaller 1.0.0", File.ReadAllText(Path.Combine(_dir, "Uninstall.exe")));
        Assert.Equal(
            "CyberPad-Install 1\nversion=1.0.0\nCyberPad.exe\nwwwroot\\index.html\nwwwroot\\js\\old.js\nlegacy\\only-v1\\data.bin\n",
            File.ReadAllText(Path.Combine(_dir, "install.manifest")));
        Assert.DoesNotContain(Directory.GetDirectories(_dir), d => Path.GetFileName(d).StartsWith(".cyberpad-setup-"));

        string exe = _dir + @"\CyberPad.exe";
        Assert.Equal($"{exe}|{_dir}|{exe}", _shortcuts.Dump());
        Assert.Equal(1, _notify.Calls);

        Assert.Equal("CyberPad", _registry.GetValue(RegistryKeyId.UninstallEntry, "DisplayName"));
        Assert.Equal("1.0.0", _registry.GetValue(RegistryKeyId.UninstallEntry, "DisplayVersion"));
        Assert.Equal("CyberPad", _registry.GetValue(RegistryKeyId.UninstallEntry, "Publisher"));
        Assert.Equal(_dir, _registry.GetValue(RegistryKeyId.UninstallEntry, "InstallLocation"));
        Assert.Equal(exe, _registry.GetValue(RegistryKeyId.UninstallEntry, "DisplayIcon"));
        Assert.Equal("\"" + _dir + "\\Uninstall.exe\"", _registry.GetValue(RegistryKeyId.UninstallEntry, "UninstallString"));
        Assert.Equal(1, _registry.GetValue(RegistryKeyId.UninstallEntry, "NoModify"));
        Assert.Equal(1, _registry.GetValue(RegistryKeyId.UninstallEntry, "NoRepair"));
        Assert.Equal(1, _registry.GetValue(RegistryKeyId.UninstallEntry, "EstimatedSize"));
        Assert.Equal("CyberPad", _registry.GetValue(RegistryKeyId.OpenWithApplication, "FriendlyAppName"));
        Assert.Equal("\"" + exe + "\" \"%1\"", _registry.GetValue(RegistryKeyId.OpenWithCommand, ""));
        Assert.Equal(new[] { ".cpnote", ".md", ".txt" }, _registry.GetValueNames(RegistryKeyId.OpenWithSupportedTypes).OrderBy(x => x));
        Assert.Equal(9, _registry.GetValueNames(RegistryKeyId.UninstallEntry).Count);

        ExistingInstall? existing = Installer.FindExisting(_registry, _probe, _env);
        Assert.NotNull(existing);
        Assert.Equal(_dir, existing!.InstallDir);
        Assert.Equal("1.0.0", existing.Version);
    }

    [Fact]
    public void EstimatedSize_IsKilobytesRoundedUp()
    {
        var payload = new[] { ("CyberPad.exe", new string('x', 5000)) };
        Install(payload, "1.0.0");
        long bytes = 5000 + "uninstaller 1.0.0".Length + "CyberPad-Install 1\nversion=1.0.0\nCyberPad.exe\n".Length;
        Assert.Equal((int)((bytes + 1023) / 1024), _registry.GetValue(RegistryKeyId.UninstallEntry, "EstimatedSize"));
    }

    [Fact]
    public void Update_ReplacesFiles_AndRemovesOnlyFilesTheOldManifestHad()
    {
        Install(V1, "1.0.0");
        File.WriteAllText(Path.Combine(_dir, "wwwroot", "js", "mine.js"), "user file");
        File.WriteAllText(Path.Combine(_dir, "notes.txt"), "user file");

        Assert.Equal(InstallPathKind.ExistingInstall, InstallPathPolicy.Evaluate(_dir, _probe, _env).Kind);
        InstallResult result = Install(V2, "2.0.0");

        Assert.True(result.WasUpdate);
        Assert.Empty(result.Leftovers);
        Assert.Equal("app v2", File.ReadAllText(Path.Combine(_dir, "CyberPad.exe")));
        Assert.Equal("index v2", File.ReadAllText(Path.Combine(_dir, "wwwroot", "index.html")));
        Assert.Equal("new", File.ReadAllText(Path.Combine(_dir, "wwwroot", "js", "new.js")));
        Assert.Equal("uninstaller 2.0.0", File.ReadAllText(Path.Combine(_dir, "Uninstall.exe")));
        Assert.False(File.Exists(Path.Combine(_dir, "wwwroot", "js", "old.js")));
        Assert.False(Directory.Exists(Path.Combine(_dir, "legacy")));
        Assert.Equal("user file", File.ReadAllText(Path.Combine(_dir, "wwwroot", "js", "mine.js")));
        Assert.Equal("user file", File.ReadAllText(Path.Combine(_dir, "notes.txt")));
        Assert.DoesNotContain(Directory.GetDirectories(_dir), d => Path.GetFileName(d).StartsWith(".cyberpad-setup-"));
        Assert.Equal("2.0.0", _registry.GetValue(RegistryKeyId.UninstallEntry, "DisplayVersion"));
        Assert.Equal("2.0.0", InstallManifest.TryReadFrom(_dir, _probe)!.Version);
    }

    [Fact]
    public void Update_RefusesToReplaceAFileTheOldInstallDidNotWrite()
    {
        Install(V1, "1.0.0");
        File.WriteAllText(Path.Combine(_dir, "wwwroot", "js", "new.js"), "user's own new.js");
        string before = State();

        var ex = Assert.Throws<InstallException>(() => Install(V2, "2.0.0"));

        Assert.Equal(InstallMessages.FilesInTheWay, ex.Message);
        Assert.Equal(before, State());
    }

    public static IEnumerable<object[]> Steps() => new[]
    {
        new object[] { "payload" },
        new object[] { "uninstaller" },
        new object[] { "manifest" },
        new object[] { "remove-old" },
        new object[] { "shortcut" },
        new object[] { "registry:UninstallEntry:DisplayName" },
        new object[] { "registry:UninstallEntry:DisplayVersion" },
        new object[] { "registry:UninstallEntry:Publisher" },
        new object[] { "registry:UninstallEntry:InstallLocation" },
        new object[] { "registry:UninstallEntry:DisplayIcon" },
        new object[] { "registry:UninstallEntry:UninstallString" },
        new object[] { "registry:UninstallEntry:NoModify" },
        new object[] { "registry:UninstallEntry:NoRepair" },
        new object[] { "registry:UninstallEntry:EstimatedSize" },
        new object[] { "registry:OpenWithApplication:FriendlyAppName" },
        new object[] { "registry:OpenWithCommand:" },
        new object[] { "registry:OpenWithSupportedTypes:.md" },
        new object[] { "registry:OpenWithSupportedTypes:.txt" },
        new object[] { "registry:OpenWithSupportedTypes:.cpnote" },
        new object[] { "notify" },
    };

    [Theory]
    [MemberData(nameof(Steps))]
    public void FreshInstall_FailingAtAnyStep_LeavesEverythingAsBefore(string step)
    {
        string before = State();
        Assert.Throws<InstallException>(() => RunWithFailure(step, V1, "1.0.0"));
        Assert.Equal(before, State());
        Assert.False(Directory.Exists(_dir));
        Assert.False(Directory.Exists(Path.GetDirectoryName(_dir))); // the Programs folder this run created is gone too
    }

    [Theory]
    [MemberData(nameof(Steps))]
    public void Update_FailingAtAnyStep_RestoresTheOldInstall(string step)
    {
        Install(V1, "1.0.0");
        File.WriteAllText(Path.Combine(_dir, "notes.txt"), "user file");
        string before = State();
        int notifyCalls = _notify.Calls;

        Assert.Throws<InstallException>(() => RunWithFailure(step, V2, "2.0.0"));

        Assert.Equal(before, State());
        Assert.Equal("1.0.0", Installer.FindExisting(_registry, _probe, _env)!.Version);
        Assert.Equal(notifyCalls, _notify.Calls);
    }

    private void RunWithFailure(string step, (string, string)[] payload, string version)
    {
        if (step == "payload")
        {
            // Valid entries are written first, then the size cap is hit on the last one.
            var big = payload.Concat(new[] { ("zz-last.bin", new string('z', 4096)) }).ToArray();
            Install(big, version, setup: i => i.Extractor = new PayloadExtractor(100, 1024));
            return;
        }

        if (step == "uninstaller")
        {
            Installer installer = NewInstaller();
            using MemoryStream zip = TestZips.Build(payload);
            using var broken = new FailingStream();
            installer.Install(new InstallRequest(_dir, version, zip, broken), null);
            return;
        }

        if (step == "shortcut")
        {
            _shortcuts.FailNextCreate = true;
        }
        else if (step == "notify")
        {
            _notify.FailNext = true;
        }
        else if (step.StartsWith("registry:"))
        {
            string[] parts = step.Split(':');
            _registry.FailOnceOn = (Enum.Parse<RegistryKeyId>(parts[1]), parts[2]);
        }

        InstallStep? injectAt = step switch
        {
            "manifest" => InstallStep.Manifest,
            "remove-old" => InstallStep.RemoveOldFiles,
            _ => null,
        };

        Install(payload, version, setup: i => i.StepStarting = s =>
        {
            if (s == injectAt) throw new InstallException("injected");
        });
    }

    [Fact]
    public void FailureWhenUndoAlsoFails_SaysSo()
    {
        _registry.FailOnceOn = (RegistryKeyId.UninstallEntry, "NoRepair");
        _registry.FailDeletes = true; // the undo deletes the keys first, so it fails too

        var ex = Assert.Throws<InstallException>(() => Install(V1, "1.0.0"));

        Assert.Equal(InstallMessages.UndoIncomplete, ex.Message);
        Assert.False(Directory.Exists(_dir)); // the files were still removed
    }

    [Fact]
    public void FailureInsideTheFinalCommitOfAnUpdate_KeepsTheNewInstall()
    {
        Install(V1, "1.0.0");

        InstallResult result = Install(V2, "2.0.0", setup: i => i.JournalCommitStep = _ => throw new IOException("injected"));

        Assert.True(result.WasUpdate);
        Assert.NotEmpty(result.Leftovers);
        Assert.Equal("app v2", File.ReadAllText(Path.Combine(_dir, "CyberPad.exe")));
        Assert.Equal("index v2", File.ReadAllText(Path.Combine(_dir, "wwwroot", "index.html")));
        Assert.Equal("new", File.ReadAllText(Path.Combine(_dir, "wwwroot", "js", "new.js")));
        Assert.Equal("uninstaller 2.0.0", File.ReadAllText(Path.Combine(_dir, "Uninstall.exe")));
        Assert.False(File.Exists(Path.Combine(_dir, "wwwroot", "js", "old.js")));
        Assert.Equal("2.0.0", _registry.GetValue(RegistryKeyId.UninstallEntry, "DisplayVersion"));
        Assert.Equal("2.0.0", Installer.FindExisting(_registry, _probe, _env)!.Version);
        string exe = _dir + @"\CyberPad.exe";
        Assert.Equal($"{exe}|{_dir}|{exe}", _shortcuts.Dump());
    }

    [Fact]
    public void UnexpectedExceptionDuringAnUpdate_IsUndone_AndReportedSafely()
    {
        Install(V1, "1.0.0");
        string before = State();

        var ex = Assert.Throws<InstallException>(() => Install(V2, "2.0.0", setup: i => i.StepStarting = s =>
        {
            if (s == InstallStep.Registry) throw new InvalidOperationException("injected");
        }));

        Assert.Equal(InstallMessages.UnexpectedFailure, ex.Message);
        Assert.IsType<InvalidOperationException>(ex.InnerException);
        Assert.Equal(before, State());
        Assert.Equal("1.0.0", Installer.FindExisting(_registry, _probe, _env)!.Version);
    }

    [Fact]
    public void UnexpectedExceptionWhenUndoAlsoFails_SaysSo()
    {
        _registry.FailDeletes = true; // the undo deletes the keys first, so it fails too

        var ex = Assert.Throws<InstallException>(() => Install(V1, "1.0.0", setup: i => i.StepStarting = s =>
        {
            if (s == InstallStep.Notify) throw new InvalidOperationException("injected");
        }));

        Assert.Equal(InstallMessages.UndoIncomplete, ex.Message);
    }

    [Fact]
    public void ReadOnlyApp_IsReplacedByTheUpdate()
    {
        Install(V1, "1.0.0");
        File.SetAttributes(Path.Combine(_dir, "CyberPad.exe"), FileAttributes.ReadOnly);

        InstallResult result = Install(V2, "2.0.0");

        Assert.Empty(result.Leftovers);
        Assert.Equal("app v2", File.ReadAllText(Path.Combine(_dir, "CyberPad.exe")));
    }

    [Fact]
    public void AppThatStaysDenied_StopsTheUpdate_WithNothingChanged()
    {
        Install(V1, "1.0.0");
        string before = State();
        var probe = new OverridingProbe { WritableOverride = f => f.EndsWith(@"\CyberPad.exe", StringComparison.OrdinalIgnoreCase) ? FileWriteCheck.Denied : null };
        var installer = new Installer(_registry, _shortcuts, _notify, probe, _env);
        using MemoryStream zip = TestZips.Build(V2);
        using var uninstaller = new MemoryStream(Encoding.UTF8.GetBytes("uninstaller 2.0.0"));

        var ex = Assert.Throws<InstallException>(() => installer.Install(new InstallRequest(_dir, "2.0.0", zip, uninstaller), null));

        Assert.Equal("Setup cannot replace CyberPad.exe. Check that the file is not read-only.", ex.Message);
        Assert.Equal(before, State());
    }

    [Fact]
    public void UnlistedReadOnlyApp_IsNotTouched()
    {
        // A CyberPad.exe the old install did not write is never made writable by setup.
        Directory.CreateDirectory(_dir);
        string exe = Path.Combine(_dir, "CyberPad.exe");
        File.WriteAllText(exe, "someone else's");
        File.SetAttributes(exe, FileAttributes.ReadOnly);
        try
        {
            try
            {
                Install(V1, "1.0.0"); // refused, or redirected into a subfolder; either way exe is not touched
            }
            catch (InstallException)
            {
            }

            Assert.True((File.GetAttributes(exe) & FileAttributes.ReadOnly) != 0);
            Assert.Equal("someone else's", File.ReadAllText(exe));
        }
        finally
        {
            File.SetAttributes(exe, FileAttributes.Normal);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void UnreadableShortcut_IsOverwritten(bool update)
    {
        if (update) Install(V1, "1.0.0");
        _shortcuts.Unreadable = true;

        Install(V2, "2.0.0");

        string exe = _dir + @"\CyberPad.exe";
        Assert.Equal($"{exe}|{_dir}|{exe}", _shortcuts.Dump());
        Assert.False(_shortcuts.Unreadable);
    }

    [Fact]
    public void RunningApp_StopsTheUpdate_WithNothingChanged()
    {
        Install(V1, "1.0.0");
        string before = State();
        using (new FileStream(Path.Combine(_dir, "CyberPad.exe"), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var ex = Assert.Throws<InstallException>(() => Install(V2, "2.0.0"));
            Assert.Equal("Close CyberPad, then choose Update again.", ex.Message);
        }

        Assert.Equal(before, State());
    }

    [Fact]
    public void PayloadWithoutTheApp_IsRefused()
    {
        string before = State();
        var ex = Assert.Throws<InstallException>(() => Install(new[] { ("readme.txt", "x") }, "1.0.0"));
        Assert.Equal(InstallMessages.PayloadDamaged, ex.Message);
        Assert.Equal(before, State());
    }

    [Fact]
    public void HostilePayload_NeverWritesOutside()
    {
        string before = State();
        var payload = new[] { ("CyberPad.exe", "x"), ("../../../victim.txt", "pwned") };
        Assert.Throws<InstallException>(() => Install(payload, "1.0.0"));
        Assert.Equal(before, State());
    }

    [Theory]
    [InlineData("notes")]
    [InlineData("profile")]
    [InlineData("admin")]
    [InlineData("unc")]
    [InlineData("outside-profile")]
    [InlineData("startup")]
    [InlineData("temp")]
    public void FolderBreakingARule_IsRefusedBeforeAnythingHappens(string which)
    {
        string dir = which switch
        {
            "notes" => _env.NotesFolder,
            "profile" => _env.UserProfile,
            "admin" => _env.ProgramFiles + @"\CyberPad",
            "outside-profile" => _temp.Path_("Tools", "CyberPad"),
            "startup" => _env.Startup + @"\CyberPad",
            "temp" => _env.Temp + @"\CyberPad",
            _ => @"\\server\share\CyberPad",
        };
        string before = State();

        Assert.Throws<InstallException>(() => Install(V1, "1.0.0", dir));

        Assert.Equal(before, State());
        Assert.Equal(0, _notify.Calls);
    }

    [Fact]
    public void FolderWithOtherFiles_IsNotSilentlySwappedForItsSubfolder()
    {
        // The window shows the CyberPad subfolder before Install; a request for the parent means the folder
        // changed after it was checked.
        string tools = Path.Combine(_env.UserProfile, "Tools");
        Directory.CreateDirectory(tools);
        File.WriteAllText(Path.Combine(tools, "other.txt"), "x");
        string before = State();

        var ex = Assert.Throws<InstallException>(() => Install(V1, "1.0.0", tools));

        Assert.Equal("That folder changed since you chose it. Check the folder and choose Install again.", ex.Message);
        Assert.Equal(before, State());

        InstallResult result = Install(V1, "1.0.0", tools + @"\CyberPad");
        Assert.Equal(tools + @"\CyberPad", result.InstallDir);
        Assert.True(File.Exists(Path.Combine(tools, "CyberPad", "CyberPad.exe")));
    }

    [Fact]
    public void OlderVersion_IsRefused_AndChangesNothing()
    {
        Install(V1, "2.0.0");
        string before = State();

        var ex = Assert.Throws<InstallException>(() => Install(V2, "1.9.9"));

        Assert.Equal("A newer version of CyberPad (2.0.0) is already installed.", ex.Message);
        Assert.Equal(before, State());
    }

    [Theory]
    [InlineData("1.0.0")]
    [InlineData("1.0")]
    [InlineData("1.0.1")]
    [InlineData("1.10.0")]
    public void SameOrNewerVersion_Updates(string version)
    {
        Install(V1, "1.0.0");
        InstallResult result = Install(V2, version);
        Assert.True(result.WasUpdate);
        Assert.Equal(version, _registry.GetValue(RegistryKeyId.UninstallEntry, "DisplayVersion"));
    }

    [Fact]
    public void ThrowingProgressAfterTheCommit_NeverClaimsAnUndo()
    {
        var progress = new ThrowingAt100();

        var ex = Assert.Throws<InstallException>(() => Install(V1, "1.0.0", progress: progress));

        Assert.Equal("CyberPad was installed, but setup could not finish cleaning up.", ex.Message);
        Assert.Equal("1.0.0", Installer.FindExisting(_registry, _probe, _env)!.Version);
    }

    [Fact]
    public void ShortcutThatThrowsAnyException_IsTreatedAsAbsent()
    {
        _shortcuts.ReadThrows = new ArgumentException("injected: odd shortcut");

        Install(V1, "1.0.0");

        string exe = _dir + @"\CyberPad.exe";
        Assert.Equal($"{exe}|{_dir}|{exe}", _shortcuts.Dump());
    }

    [Fact]
    public void ReadOnlyFileReplacedByAnUpdate_LeavesNoBackupBehind()
    {
        Install(V1, "1.0.0");
        File.SetAttributes(Path.Combine(_dir, "wwwroot", "index.html"), FileAttributes.ReadOnly);
        File.SetAttributes(Path.Combine(_dir, "wwwroot", "js", "old.js"), FileAttributes.ReadOnly);

        InstallResult result = Install(V2, "2.0.0");

        Assert.Empty(result.Leftovers);
        Assert.DoesNotContain(Directory.GetDirectories(_dir), d => Path.GetFileName(d).StartsWith(".cyberpad-setup-"));
    }

    // --- an "Open with" entry that existed before setup ------------------------------------------------

    private const string PortableCommand = "\"C:\\Users\\u\\Downloads\\CyberPad\\CyberPad.exe\" \"%1\"";

    private void PortableRegistration()
    {
        // What Windows writes when "Open with → Choose another app" is used with the portable CyberPad.exe.
        _registry.SetString(RegistryKeyId.OpenWithCommand, "", PortableCommand);
        _registry.SetString(RegistryKeyId.OpenWithApplication, "NoOpenWith", "");
    }

    private string OpenWithDump() => string.Join("\n", _registry.Keys
        .Where(k => k.Key != RegistryKeyId.UninstallEntry)
        .OrderBy(k => k.Key)
        .SelectMany(k => new[] { k.Key + ":" }.Concat(k.Value.Select(v => $"  {v.Key}={v.Value}"))));

    [Fact]
    public void OpenWith_FreshMachine_IsCreatedAndThenRemoved()
    {
        Install(V1, "1.0.0");
        Assert.Equal("\"" + _dir + "\\CyberPad.exe\" \"%1\"", _registry.GetValue(RegistryKeyId.OpenWithCommand, ""));
        Assert.Null(_registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.OpenWithExistedValue));
        Assert.Null(_registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.PreviousOpenCommandValue));

        NewUninstaller().Uninstall();

        Assert.Empty(_registry.Keys);
    }

    [Fact]
    public void OpenWith_PortableRegistration_IsRepointed_AndRestoredExactlyByUninstall()
    {
        PortableRegistration();
        string before = _registry.Dump();

        Install(V1, "1.0.0");
        Assert.Equal("\"" + _dir + "\\CyberPad.exe\" \"%1\"", _registry.GetValue(RegistryKeyId.OpenWithCommand, ""));
        Assert.Equal(PortableCommand, _registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.PreviousOpenCommandValue));
        Assert.Equal(1, _registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.OpenWithExistedValue));

        NewUninstaller().Uninstall();

        Assert.Equal(before, _registry.Dump());
    }

    [Fact]
    public void OpenWith_PortableRegistration_SurvivesAnUpdate_AndUninstallRestoresTheOriginal()
    {
        PortableRegistration();
        string before = _registry.Dump();

        Install(V1, "1.0.0");
        Install(V2, "2.0.0");
        Assert.Equal(PortableCommand, _registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.PreviousOpenCommandValue));

        NewUninstaller().Uninstall();

        Assert.Equal(before, _registry.Dump());
    }

    [Fact]
    public void OpenWith_ChangedBySomethingElseAfterInstall_IsLeftAlone()
    {
        Install(V1, "1.0.0");
        _registry.SetString(RegistryKeyId.OpenWithCommand, "", "\"C:\\Other\\CyberPad.exe\" \"%1\"");
        string openWith = OpenWithDump();

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.Equal(openWith, OpenWithDump());
        Assert.False(_registry.KeyExists(RegistryKeyId.UninstallEntry));
        Assert.Equal("CyberPad was removed.", result.Message);
    }

    [Fact]
    public void OpenWith_FailedInstall_PutsThePortableRegistrationBack()
    {
        PortableRegistration();
        string before = _registry.Dump();

        Assert.Throws<InstallException>(() => RunWithFailure("notify", V1, "1.0.0"));

        Assert.Equal(before, _registry.Dump());
    }

    [Fact]
    public void OpenWith_StaleUninstallEntry_DoesNotMakeAFreshInstallReadSavedValues()
    {
        PortableRegistration();
        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", _env.UserProfile); // refused folder: not an existing install
        string before = OpenWithDump();

        InstallResult result = Install(V1, "1.0.0");
        Assert.False(result.WasUpdate);
        Assert.Equal(PortableCommand, _registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.PreviousOpenCommandValue));

        NewUninstaller().Uninstall();

        Assert.Equal(before, OpenWithDump());
    }

    [Fact]
    public void OpenWith_OurOwnLeftoverCommand_IsNotTreatedAsAPreviousRegistration()
    {
        _registry.SetString(RegistryKeyId.OpenWithCommand, "", "\"" + _dir + "\\cyberpad.exe\" \"%1\"");

        Install(V1, "1.0.0");
        Assert.Null(_registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.OpenWithExistedValue));

        NewUninstaller().Uninstall();

        Assert.Empty(_registry.Keys);
    }

    [Fact]
    public void OpenWith_ReRegisteredAfterInstall_IsRestoredAfterAnUpdateAndUninstall()
    {
        Install(V1, "1.0.0");
        const string other = "\"C:\\Other\\CyberPad.exe\" \"%1\"";
        _registry.SetString(RegistryKeyId.OpenWithCommand, "", other);

        Install(V2, "2.0.0");
        Assert.Equal("\"" + _dir + "\\CyberPad.exe\" \"%1\"", _registry.GetValue(RegistryKeyId.OpenWithCommand, ""));

        NewUninstaller().Uninstall();

        Assert.Equal(other, _registry.GetValue(RegistryKeyId.OpenWithCommand, ""));
    }

    [Fact]
    public void OpenWith_SavedCommandOver2048Characters_IsIgnoredAndTheKeyDeleted()
    {
        Install(V1, "1.0.0");
        _registry.SetDword(RegistryKeyId.UninstallEntry, RegistryKeys.OpenWithExistedValue, 1);
        _registry.SetString(RegistryKeyId.UninstallEntry, RegistryKeys.PreviousOpenCommandValue, new string('a', 5000));

        NewUninstaller().Uninstall();

        Assert.False(_registry.KeyExists(RegistryKeyId.OpenWithApplication));
    }

    private Uninstaller NewUninstaller() => new(_registry, _shortcuts, _notify, _probe, _env);

    private sealed class ThrowingAt100 : IProgress<int>
    {
        public void Report(int value)
        {
            if (value == 100) throw new InvalidOperationException("injected");
        }
    }

    [Fact]
    public void FindExisting_IgnoresARegistryEntryThatPointsAtARefusedOrInvalidFolder()
    {
        Assert.Null(Installer.FindExisting(_registry, _probe, _env));

        // The notes folder, with a manifest planted in it.
        Directory.CreateDirectory(_env.NotesFolder);
        File.WriteAllText(Path.Combine(_env.NotesFolder, "install.manifest"), "CyberPad-Install 1\nversion=1\nnote.md\n");
        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", _env.NotesFolder);
        Assert.Null(Installer.FindExisting(_registry, _probe, _env));

        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", _env.UserProfile);
        Assert.Null(Installer.FindExisting(_registry, _probe, _env));

        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", @"\\server\share\CyberPad");
        Assert.Null(Installer.FindExisting(_registry, _probe, _env));

        _registry.SetDword(RegistryKeyId.UninstallEntry, "InstallLocation", 5);
        Assert.Null(Installer.FindExisting(_registry, _probe, _env));

        // A real folder without a manifest.
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, "x.txt"), "x");
        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", _dir);
        Assert.Null(Installer.FindExisting(_registry, _probe, _env));
    }

    [Fact]
    public void InvalidVersion_IsRefused() =>
        Assert.Throws<ArgumentException>(() => Install(V1, "1.0.0-beta"));

    private sealed class FailingStream : MemoryStream
    {
        private int _reads;

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_reads++ > 0) throw new IOException("injected");
            buffer[offset] = (byte)'M';
            return 1;
        }
    }
}

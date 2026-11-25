using System.Text;
using CyberPad.Install;

namespace CyberPad.Desktop.Tests;

/// <summary>Uninstalls from a temp folder with fake registry, shortcut and notify; nothing real is touched.</summary>
[Collection(InstallTestCollection.Name)]
public sealed class UninstallerTests : IDisposable
{
    private readonly InstallTempDir _temp = new();
    private readonly InstallEnvironment _env;
    private readonly FakeRegistry _registry = new();
    private readonly FakeShortcuts _shortcuts = new();
    private readonly FakeNotify _notify = new();
    private readonly FileSystemProbe _probe = new();
    private readonly string _dir;
    private readonly string _victimDir;
    private readonly string _victim;

    public UninstallerTests()
    {
        _env = TestEnvironments.Under(_temp.Root);
        _dir = _env.DefaultInstallFolder;
        _victimDir = _temp.Path_("victim");
        _victim = Path.Combine(_victimDir, "victim.txt");
        Directory.CreateDirectory(_victimDir);
        File.WriteAllText(_victim, "keep me");
    }

    public void Dispose()
    {
        Assert.Equal("keep me", File.ReadAllText(_victim)); // every test: the file outside is never touched
        _temp.Dispose();
    }

    private Uninstaller NewUninstaller(InstallEnvironment? env = null) => new(_registry, _shortcuts, _notify, _probe, env ?? _env);

    private void InstallV1()
    {
        using MemoryStream zip = TestZips.Build(InstallerTests.V1);
        using var uninstaller = new MemoryStream(Encoding.UTF8.GetBytes("uninstaller"));
        new Installer(_registry, _shortcuts, _notify, _probe, _env).Install(new InstallRequest(_dir, "1.0.0", zip, uninstaller), null);
    }

    private string State() => _temp.Dump() + "\n--\n" + _registry.Dump() + "\n--\n" + _shortcuts.Dump();

    private void WriteManifest(params string[] lines) =>
        File.WriteAllText(Path.Combine(_dir, "install.manifest"), "CyberPad-Install 1\nversion=1.0.0\n" + string.Concat(lines.Select(l => l + "\n")));

    [Fact]
    public void InstallThenUninstall_LeavesTheFolderGoneAndTheFakesEmpty()
    {
        InstallV1();

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.Equal("CyberPad was removed.", result.Message);
        Assert.Empty(result.NotDeleted);
        Assert.Equal(_dir, result.InstallDir);
        Assert.False(Directory.Exists(_dir));
        Assert.Empty(_registry.Keys);
        Assert.Null(_shortcuts.Current);
        Assert.Equal(2, _notify.Calls);
    }

    [Fact]
    public void StrayUserFiles_SurviveAndSoDoesTheFolder()
    {
        InstallV1();
        File.WriteAllText(Path.Combine(_dir, "my-notes.txt"), "mine");
        File.WriteAllText(Path.Combine(_dir, "wwwroot", "js", "mine.js"), "mine");

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.Equal("CyberPad was removed.", result.Message);
        Assert.Equal(new[] { "my-notes.txt", "wwwroot" }, Directory.GetFileSystemEntries(_dir).Select(Path.GetFileName).OrderBy(n => n));
        Assert.Equal("mine", File.ReadAllText(Path.Combine(_dir, "wwwroot", "js", "mine.js")));
        Assert.False(File.Exists(Path.Combine(_dir, "wwwroot", "index.html")));
        Assert.False(Directory.Exists(Path.Combine(_dir, "legacy")));
        Assert.Empty(_registry.Keys);
    }

    [Fact]
    public void ShortcutPointingElsewhere_IsLeftAlone()
    {
        InstallV1();
        var other = new ShortcutInfo(@"C:\Other\CyberPad.exe", @"C:\Other", @"C:\Other\CyberPad.exe");
        _shortcuts.Current = other;

        NewUninstaller().Uninstall();

        Assert.Same(other, _shortcuts.Current);
    }

    [Fact]
    public void RunningApp_IsReported_AndNothingIsRemoved()
    {
        InstallV1();
        string before = State();
        using (new FileStream(Path.Combine(_dir, "CyberPad.exe"), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var ex = Assert.Throws<InstallException>(() => NewUninstaller().Uninstall());
            Assert.Equal("Close CyberPad, then choose Uninstall again.", ex.Message);
        }

        Assert.Equal(before, State());
    }

    [Fact]
    public void FileThatCannotBeDeleted_IsReported()
    {
        InstallV1();
        string held = Path.Combine(_dir, "wwwroot", "index.html");
        UninstallResult result;
        using (new FileStream(held, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            result = NewUninstaller().Uninstall();
        }

        Assert.Contains(held, result.NotDeleted);
        Assert.Equal("CyberPad was removed. Some files could not be deleted: " + _dir, result.Message);
        Assert.True(File.Exists(held));
        Assert.Empty(_registry.Keys);
        Assert.Null(_shortcuts.Current);
    }

    [Fact]
    public void FileThatCannotBeDeleted_StaysListed_InARewrittenManifest()
    {
        InstallV1();
        string held = Path.Combine(_dir, "wwwroot", "index.html");
        using (new FileStream(held, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            NewUninstaller().Uninstall();
        }

        InstallManifest? manifest = InstallManifest.TryReadFrom(_dir, _probe);
        Assert.NotNull(manifest);
        Assert.Equal("1.0.0", manifest!.Version);
        Assert.Equal(new[] { @"wwwroot\index.html" }, manifest.Files.Select(f => f.Replace('/', '\\')));
        Assert.False(File.Exists(Path.Combine(_dir, "CyberPad.exe")));
        Assert.False(File.Exists(Path.Combine(_dir, "Uninstall.exe")));
        Assert.Empty(Directory.GetFiles(_dir, "*.tmp"));
        Assert.Empty(_registry.Keys);
    }

    // --- a missing or invalid file list: only the entry and the shortcut go ------------------------

    private void AssertEntryOnlyRemoval(UninstallResult result, string before, string folder)
    {
        Assert.True(result.FilesLeftInPlace);
        Assert.Equal(
            "CyberPad's entry and shortcut were removed. The files in " + folder + " were left because setup's file list is missing.",
            result.Message);
        Assert.Equal(before, _temp.Dump());
        Assert.Empty(_registry.Keys);
    }

    [Theory]
    [InlineData(@"..\..\..\victim\victim.txt")]
    [InlineData(@"..\..\..\..\victim\victim.txt")]
    [InlineData(@"wwwroot\..\..\x")]
    [InlineData(@"C:\Windows\win.ini")]
    [InlineData(@"\victim\victim.txt")]
    [InlineData("victim.txt:stream")]
    [InlineData(@"install.manifest\x")]
    public void TamperedManifest_DeletesNoFile_ButRemovesTheEntryAndOurShortcut(string hostileLine)
    {
        InstallV1();
        File.WriteAllText(Path.Combine(_dir, "victim.txt"), "inside");
        WriteManifest("CyberPad.exe", "victim.txt", hostileLine);
        string before = _temp.Dump();

        UninstallResult result = NewUninstaller().Uninstall();

        AssertEntryOnlyRemoval(result, before, _dir);
        Assert.Equal("inside", File.ReadAllText(Path.Combine(_dir, "victim.txt")));
        Assert.Null(_shortcuts.Current);
    }

    [Fact]
    public void MissingManifest_DeletesNoFile_ButRemovesTheEntryAndOurShortcut()
    {
        InstallV1();
        File.Delete(Path.Combine(_dir, "install.manifest"));
        string before = _temp.Dump();

        UninstallResult result = NewUninstaller().Uninstall();

        AssertEntryOnlyRemoval(result, before, _dir);
        Assert.True(File.Exists(Path.Combine(_dir, "CyberPad.exe")));
        Assert.Null(_shortcuts.Current);
        Assert.Equal(2, _notify.Calls);
    }

    [Fact]
    public void MissingManifest_LeavesAShortcutThatIsNotOurs()
    {
        InstallV1();
        File.Delete(Path.Combine(_dir, "install.manifest"));
        var other = new ShortcutInfo(@"C:\Other\CyberPad.exe", @"C:\Other", @"C:\Other\CyberPad.exe");
        _shortcuts.Current = other;
        string before = _temp.Dump();

        UninstallResult result = NewUninstaller().Uninstall();

        AssertEntryOnlyRemoval(result, before, _dir);
        Assert.Same(other, _shortcuts.Current);
    }

    [Fact]
    public void EntryWithoutAnInstallLocation_RemovesOnlyTheEntry()
    {
        _registry.SetString(RegistryKeyId.UninstallEntry, "DisplayName", "CyberPad");
        var other = new ShortcutInfo(@"C:\Other\CyberPad.exe", @"C:\Other", @"C:\Other\CyberPad.exe");
        _shortcuts.Current = other;
        string before = _temp.Dump();

        UninstallResult result = NewUninstaller().Uninstall();

        AssertEntryOnlyRemoval(result, before, "the install folder");
        Assert.Same(other, _shortcuts.Current);
    }

    [Fact]
    public void EntryPointingOutsideTheProfile_DeletesNoFileThere()
    {
        string other = _temp.Path_("other", "CyberPad");
        Directory.CreateDirectory(other);
        File.WriteAllText(Path.Combine(other, "listed.txt"), "x");
        File.WriteAllText(Path.Combine(other, "install.manifest"), "CyberPad-Install 1\nversion=1\nlisted.txt\n");
        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", other);
        string before = _temp.Dump();

        UninstallResult result = NewUninstaller().Uninstall();

        AssertEntryOnlyRemoval(result, before, other);
    }

    [Fact]
    public void ManifestPathThroughAJunction_IsSkipped_AndTheTargetSurvives()
    {
        InstallV1();
        _temp.CreateJunction(Path.Combine(_dir, "linked"), _victimDir);
        WriteManifest("CyberPad.exe", @"linked\victim.txt");

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.Contains(Path.Combine(_dir, "linked", "victim.txt"), result.NotDeleted);
        Assert.True(Directory.Exists(Path.Combine(_dir, "linked")));
        Assert.True(File.Exists(_victim));
    }

    [Fact]
    public void ManifestNamingAJunctionAsAFile_DoesNotDeleteThroughIt()
    {
        InstallV1();
        _temp.CreateJunction(Path.Combine(_dir, "linked"), _victimDir);
        WriteManifest("CyberPad.exe", "linked");

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.Contains(Path.Combine(_dir, "linked"), result.NotDeleted);
        Assert.True(File.Exists(_victim));
    }

    [Fact]
    public void InstallFolderReplacedByAJunction_DeletesNothingThroughIt()
    {
        InstallV1();
        string moved = _temp.Path_("moved");
        Directory.Move(_dir, moved);
        _temp.CreateJunction(_dir, moved);
        string before = _temp.Dump();

        UninstallResult result = NewUninstaller().Uninstall();

        AssertEntryOnlyRemoval(result, before, _dir);
        Assert.True(File.Exists(Path.Combine(moved, "CyberPad.exe")));
    }

    [Fact]
    public void RegistryPointingAtTheNotesFolder_DeletesNoNote()
    {
        Directory.CreateDirectory(_env.NotesFolder);
        File.WriteAllText(Path.Combine(_env.NotesFolder, "note.md"), "my note");
        File.WriteAllText(Path.Combine(_env.NotesFolder, "install.manifest"), "CyberPad-Install 1\nversion=1\nnote.md\n");
        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", _env.NotesFolder);
        string before = _temp.Dump();

        UninstallResult result = NewUninstaller().Uninstall();

        AssertEntryOnlyRemoval(result, before, _env.NotesFolder);
        Assert.Equal("my note", File.ReadAllText(Path.Combine(_env.NotesFolder, "note.md")));
    }

    [Fact]
    public void RegistryPointingAtAnotherFolderWithAPlantedManifest_DeletesOnlyListedFilesThere()
    {
        // The uninstaller never takes a caller's path; it only follows the uninstall entry, and even then
        // deletes no more than the listed files inside that folder.
        string other = Path.Combine(TestEnvironments.ProfileOf(_temp.Root), "other", "CyberPad");
        Directory.CreateDirectory(other);
        File.WriteAllText(Path.Combine(other, "listed.txt"), "x");
        File.WriteAllText(Path.Combine(other, "unlisted.txt"), "x");
        File.WriteAllText(Path.Combine(other, "install.manifest"), "CyberPad-Install 1\nversion=1\nlisted.txt\n");
        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", other);

        NewUninstaller().Uninstall();

        Assert.False(File.Exists(Path.Combine(other, "listed.txt")));
        Assert.True(File.Exists(Path.Combine(other, "unlisted.txt")));
    }

    [Fact]
    public void NotInstalled_IsReported()
    {
        var ex = Assert.Throws<InstallException>(() => NewUninstaller().Uninstall());
        Assert.Equal(InstallMessages.NotInstalled, ex.Message);
    }

    [Fact]
    public void RegistryDeleteFailure_IsReported()
    {
        InstallV1();
        _registry.FailDeletes = true;

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.Contains(@"HKEY_CURRENT_USER\" + RegistryKeys.UninstallEntryPath, result.NotDeleted);
        Assert.False(Directory.Exists(_dir));
    }

    [Fact]
    public void NotifyFailure_IsRecorded_NotThrown()
    {
        InstallV1();
        _notify.FailNext = true;

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.True(result.AssociationsNotRefreshed);
        Assert.Equal("CyberPad was removed.", result.Message);
        Assert.False(Directory.Exists(_dir));
        Assert.Empty(_registry.Keys);
    }

    [Fact]
    public void UnreadableShortcut_IsLeftAlone_AndReported()
    {
        InstallV1();
        ShortcutInfo? ours = _shortcuts.Current;
        _shortcuts.Unreadable = true;

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.Contains("Start menu shortcut CyberPad.lnk", result.NotDeleted);
        Assert.Same(ours, _shortcuts.Current);
        Assert.False(Directory.Exists(_dir));
        Assert.Empty(_registry.Keys);
    }

    [Fact]
    public void ReadOnlyApp_IsUninstalled()
    {
        InstallV1();
        File.SetAttributes(Path.Combine(_dir, "CyberPad.exe"), FileAttributes.ReadOnly);
        File.SetAttributes(Path.Combine(_dir, "wwwroot", "index.html"), FileAttributes.ReadOnly);

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.Equal("CyberPad was removed.", result.Message);
        Assert.False(Directory.Exists(_dir));
    }

    [Fact]
    public void AppThatStaysDenied_IsReported_AndNothingIsRemoved()
    {
        InstallV1();
        string before = State();
        var probe = new OverridingProbe { WritableOverride = f => f.EndsWith(@"\CyberPad.exe", StringComparison.OrdinalIgnoreCase) ? FileWriteCheck.Denied : null };

        var ex = Assert.Throws<InstallException>(() => new Uninstaller(_registry, _shortcuts, _notify, probe, _env).Uninstall());

        Assert.Equal("Uninstall cannot delete CyberPad.exe. Check that the file is not read-only.", ex.Message);
        Assert.Equal(before, State());
    }

    [Fact]
    public void EmptyBackupFoldersOfAnInterruptedSetup_AreRemoved_ButNeverTheirContents()
    {
        InstallV1();
        string empty = Path.Combine(_dir, ".cyberpad-setup-" + Guid.NewGuid().ToString("N"));
        string full = Path.Combine(_dir, ".cyberpad-setup-" + Guid.NewGuid().ToString("N"));
        string otherName = Path.Combine(_dir, ".cyberpad-setup-mine");
        Directory.CreateDirectory(empty);
        Directory.CreateDirectory(full);
        Directory.CreateDirectory(otherName);
        File.WriteAllText(Path.Combine(full, "CyberPad.exe"), "backup");

        UninstallResult result = NewUninstaller().Uninstall();

        Assert.False(Directory.Exists(empty));
        Assert.Equal("backup", File.ReadAllText(Path.Combine(full, "CyberPad.exe")));
        Assert.True(Directory.Exists(otherName));
        Assert.Equal("CyberPad was removed.", result.Message);
    }

    [Fact]
    public void BackupFolderThatIsAJunction_IsNotEntered()
    {
        InstallV1();
        string link = Path.Combine(_dir, ".cyberpad-setup-" + Guid.NewGuid().ToString("N"));
        string emptyTarget = _temp.Path_("empty-target");
        Directory.CreateDirectory(emptyTarget);
        _temp.CreateJunction(link, emptyTarget);

        NewUninstaller().Uninstall();

        Assert.True(Directory.Exists(link));
        Assert.True(Directory.Exists(emptyTarget));
    }

    // --- the notes folder ----------------------------------------------------------------------

    [Fact]
    public void DeleteNotesFolder_RemovesItsContents_ButDeletesLinksAsLinks()
    {
        string notes = _env.NotesFolder;
        Directory.CreateDirectory(Path.Combine(notes, "sub", "deeper"));
        File.WriteAllText(Path.Combine(notes, "settings.json"), "{}");
        File.WriteAllText(Path.Combine(notes, "sub", "deeper", "n.md"), "n");
        string readOnly = Path.Combine(notes, "sub", "ro.md");
        File.WriteAllText(readOnly, "ro");
        File.SetAttributes(readOnly, FileAttributes.ReadOnly);
        _temp.CreateJunction(Path.Combine(notes, "sub", "link-to-victim"), _victimDir);

        NotesDeletionResult result = NewUninstaller().DeleteNotesFolder();

        Assert.Empty(result.NotDeleted);
        Assert.Equal(notes, result.NotesFolder);
        Assert.False(Directory.Exists(notes));
        Assert.True(Directory.Exists(_env.LocalApplicationData));
        Assert.True(File.Exists(_victim));
    }

    [Fact]
    public void DeleteNotesFolder_WhenMissing_DoesNothing()
    {
        string before = _temp.Dump();
        Assert.Empty(NewUninstaller().DeleteNotesFolder().NotDeleted);
        Assert.Equal(before, _temp.Dump());
    }

    [Theory]
    [InlineData(@"\Profile\AppData\Local")]
    [InlineData(@"\Profile\AppData\Local\Other")]
    [InlineData(@"\Profile\AppData\Local\CyberPad\sub")]
    [InlineData(@"\Profile\AppData\Local\CyberPadX")]
    [InlineData(@"\Profile\AppData\Local\cyberpad")]
    [InlineData(@"\victim")]
    [InlineData(@"\Profile")]
    public void DeleteNotesFolder_RefusesAnythingButLocalAppDataCyberPad(string relative)
    {
        string notesPath = _temp.Root + relative;
        string local = TestEnvironments.LocalOf(_temp.Root);
        Directory.CreateDirectory(local + @"\CyberPad");
        File.WriteAllText(local + @"\CyberPad\keep.md", "keep");
        Directory.CreateDirectory(notesPath);
        File.WriteAllText(Path.Combine(notesPath, "also-keep.md"), "keep");
        InstallEnvironment env = TestEnvironments.Under(_temp.Root, notesPath);
        string before = _temp.Dump();

        var ex = Assert.Throws<InstallException>(() => NewUninstaller(env).DeleteNotesFolder());

        Assert.Equal(InstallMessages.NotesFolderRefused, ex.Message);
        Assert.Equal(before, _temp.Dump());
    }

    [Fact]
    public void DeleteNotesFolder_ThatIsAJunction_IsRefused()
    {
        Directory.CreateDirectory(_env.LocalApplicationData);
        _temp.CreateJunction(_env.NotesFolder, _victimDir);
        string before = _temp.Dump();

        Assert.Throws<InstallException>(() => NewUninstaller().DeleteNotesFolder());

        Assert.Equal(before, _temp.Dump());
    }

    [Fact]
    public void DeleteNotesFolder_BelowAJunction_IsRefused()
    {
        string realLocal = _temp.Path_("real-local");
        Directory.CreateDirectory(Path.Combine(realLocal, "CyberPad"));
        File.WriteAllText(Path.Combine(realLocal, "CyberPad", "n.md"), "n");
        _temp.CreateJunction(_env.LocalApplicationData, realLocal);

        Assert.Throws<InstallException>(() => NewUninstaller().DeleteNotesFolder());

        Assert.True(File.Exists(Path.Combine(realLocal, "CyberPad", "n.md")));
    }

    // A folder named "x." (or "x ") can only be made with a \\?\ path; without one, Windows strips the
    // dot or space and the name means "x". With "x" a junction to a folder outside, and the junction held
    // open so it cannot be deleted, a walk that used normal paths would delete "x.\*" through the junction.
    [Theory]
    [InlineData("x.", true)]
    [InlineData("x ", true)]
    [InlineData("x.", false)]
    [InlineData("x ", false)]
    public void DeleteNotesFolder_NameThatNormalisesOntoAJunction_NeverReachesItsTarget(string lookAlike, bool holdTheJunction)
    {
        string notes = _env.NotesFolder;
        Directory.CreateDirectory(Path.Combine(notes, "real"));
        File.WriteAllText(Path.Combine(notes, "real", "n.md"), "n");
        File.WriteAllText(Path.Combine(notes, "settings.json"), "{}");
        string extendedLookAlike = InstallTempDir.Extended + notes + "\\" + lookAlike;
        Directory.CreateDirectory(extendedLookAlike);
        File.WriteAllText(extendedLookAlike + @"\victim.txt", "decoy");
        Directory.CreateDirectory(Path.Combine(_victimDir, "sub"));
        File.WriteAllText(Path.Combine(_victimDir, "sub", "deep.txt"), "keep me too");
        string junction = Path.Combine(notes, "x");
        _temp.CreateJunction(junction, _victimDir);

        NotesDeletionResult result;
        bool junctionSurvived;
        using (holdTheJunction ? _temp.HoldWithoutDeleteSharing(junction) : null)
        {
            result = NewUninstaller().DeleteNotesFolder();
            junctionSurvived = Directory.Exists(junction);
        }

        Assert.Equal(holdTheJunction, junctionSurvived); // the hold really blocked the junction's deletion
        Assert.Equal("keep me", File.ReadAllText(_victim));
        Assert.Equal("keep me too", File.ReadAllText(Path.Combine(_victimDir, "sub", "deep.txt")));
        Assert.False(Directory.Exists(Path.Combine(notes, "real")));
        Assert.False(File.Exists(Path.Combine(notes, "settings.json")));
        Assert.Contains(notes + "\\" + lookAlike, result.NotDeleted);
        Assert.Equal("decoy", File.ReadAllText(extendedLookAlike + @"\victim.txt"));
        Assert.Contains(notes, result.NotDeleted);
        Assert.Equal(holdTheJunction, result.NotDeleted.Contains(junction));
    }

    [Fact]
    public void DeleteNotesFolder_StopsAtTheDepthLimit()
    {
        string notes = _env.NotesFolder;
        string deep = Path.Combine(notes, "a", "b", "c", "d");
        Directory.CreateDirectory(deep);
        File.WriteAllText(Path.Combine(deep, "n.md"), "n");
        File.WriteAllText(Path.Combine(notes, "a", "top.md"), "t");
        Uninstaller uninstaller = NewUninstaller();
        uninstaller.NotesDepthLimit = 2;

        NotesDeletionResult result = uninstaller.DeleteNotesFolder();

        Assert.Contains(Path.Combine(notes, "a", "b", "c"), result.NotDeleted);
        Assert.True(File.Exists(Path.Combine(deep, "n.md")));
        Assert.False(File.Exists(Path.Combine(notes, "a", "top.md")));
        Assert.Contains(notes, result.NotDeleted);
    }

    [Fact]
    public void DeleteNotesFolder_StopsAtTheEntryLimit()
    {
        string notes = _env.NotesFolder;
        Directory.CreateDirectory(notes);
        for (int i = 0; i < 10; i++)
        {
            File.WriteAllText(Path.Combine(notes, $"n{i}.md"), "n");
        }

        Uninstaller uninstaller = NewUninstaller();
        uninstaller.NotesEntryLimit = 3;

        NotesDeletionResult result = uninstaller.DeleteNotesFolder();

        Assert.Equal(new[] { notes }, result.NotDeleted);
        Assert.Equal(10, Directory.GetFiles(notes).Length);
    }
}

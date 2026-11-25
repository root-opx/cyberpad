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
    }

    [Theory]
    [InlineData(@"..\..\..\victim\victim.txt")]
    [InlineData(@"..\..\..\..\victim\victim.txt")]
    [InlineData(@"wwwroot\..\..\x")]
    [InlineData(@"C:\Windows\win.ini")]
    [InlineData(@"\victim\victim.txt")]
    [InlineData("victim.txt:stream")]
    public void TamperedManifest_RefusesTheWholeUninstall(string hostileLine)
    {
        InstallV1();
        WriteManifest("CyberPad.exe", hostileLine);
        string before = State();

        var ex = Assert.Throws<InstallException>(() => NewUninstaller().Uninstall());

        Assert.Equal(InstallMessages.NotInstalled, ex.Message);
        Assert.Equal(before, State());
    }

    [Fact]
    public void MissingManifest_RefusesTheWholeUninstall()
    {
        InstallV1();
        File.Delete(Path.Combine(_dir, "install.manifest"));
        string before = State();

        Assert.Throws<InstallException>(() => NewUninstaller().Uninstall());

        Assert.Equal(before, State());
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
    public void InstallFolderReplacedByAJunction_IsNotFound()
    {
        InstallV1();
        string moved = _temp.Path_("moved");
        Directory.Move(_dir, moved);
        _temp.CreateJunction(_dir, moved);
        string before = State();

        Assert.Throws<InstallException>(() => NewUninstaller().Uninstall());

        Assert.Equal(before, State());
        Assert.True(File.Exists(Path.Combine(moved, "CyberPad.exe")));
    }

    [Fact]
    public void RegistryPointingAtTheNotesFolder_IsRefused()
    {
        Directory.CreateDirectory(_env.NotesFolder);
        File.WriteAllText(Path.Combine(_env.NotesFolder, "note.md"), "my note");
        File.WriteAllText(Path.Combine(_env.NotesFolder, "install.manifest"), "CyberPad-Install 1\nversion=1\nnote.md\n");
        _registry.SetString(RegistryKeyId.UninstallEntry, "InstallLocation", _env.NotesFolder);

        Assert.Throws<InstallException>(() => NewUninstaller().Uninstall());

        Assert.Equal("my note", File.ReadAllText(Path.Combine(_env.NotesFolder, "note.md")));
    }

    [Fact]
    public void RegistryPointingAtAnotherFolderWithAPlantedManifest_DeletesOnlyListedFilesThere()
    {
        // The uninstaller never takes a caller's path; it only follows the uninstall entry, and even then
        // deletes no more than the listed files inside that folder.
        string other = _temp.Path_("other", "CyberPad");
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
    [InlineData(@"\Local")]
    [InlineData(@"\Local\Other")]
    [InlineData(@"\Local\CyberPad\sub")]
    [InlineData(@"\Local\CyberPadX")]
    [InlineData(@"\Local\cyberpad")]
    [InlineData(@"\victim")]
    [InlineData(@"\Profile")]
    public void DeleteNotesFolder_RefusesAnythingButLocalAppDataCyberPad(string relative)
    {
        string notesPath = _temp.Root + relative;
        Directory.CreateDirectory(_temp.Root + @"\Local\CyberPad");
        File.WriteAllText(_temp.Root + @"\Local\CyberPad\keep.md", "keep");
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
}

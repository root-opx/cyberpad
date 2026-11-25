using CyberPad.Install;

namespace CyberPad.Desktop.Tests;

[Collection(InstallTestCollection.Name)]
public sealed class InstallPathPolicyTests
{
    private const string Local = @"C:\Users\u\AppData\Local";
    private const string Programs = Local + @"\Programs";
    private const string DefaultDir = Programs + @"\CyberPad";

    private readonly InstallEnvironment _env = TestEnvironments.Typical();
    private readonly FakeProbe _probe = new FakeProbe().Dir(Programs).Dir(@"C:\Users\u\Documents").Dir(@"C:\Windows").Dir(@"C:\Tools");

    private InstallPathResult Evaluate(string? input) => InstallPathPolicy.Evaluate(input, _probe, _env);

    private void AssertRefused(string? input, string message)
    {
        InstallPathResult result = Evaluate(input);
        Assert.False(result.IsUsable, input);
        Assert.Equal(InstallPathKind.Refused, result.Kind);
        Assert.Equal(message, result.Message);
    }

    // --- usable folders and the status lines ---------------------------------------------------

    [Fact]
    public void DefaultFolder_WillBeCreated()
    {
        InstallPathResult result = Evaluate(DefaultDir);
        Assert.True(result.IsUsable);
        Assert.Equal(InstallPathKind.WillCreate, result.Kind);
        Assert.Equal(DefaultDir, result.FullPath);
        Assert.Equal("This folder will be created.", result.Message);
    }

    [Fact]
    public void MissingParents_StillWillBeCreated_WhenTheNearestExistingFolderIsWritable()
    {
        InstallPathResult result = Evaluate(@"C:\Tools\new\deeper\CyberPad");
        Assert.Equal(InstallPathKind.WillCreate, result.Kind);
    }

    [Fact]
    public void EmptyFolder_IsUsedAsIs()
    {
        _probe.Dir(DefaultDir);
        InstallPathResult result = Evaluate(DefaultDir);
        Assert.Equal(InstallPathKind.EmptyFolder, result.Kind);
        Assert.Equal("CyberPad will be installed in this folder.", result.Message);
    }

    [Fact]
    public void ExistingInstall_IsUpdated()
    {
        _probe.Install(DefaultDir);
        InstallPathResult result = Evaluate(DefaultDir);
        Assert.Equal(InstallPathKind.ExistingInstall, result.Kind);
        Assert.Equal("CyberPad is already installed here and will be updated.", result.Message);
    }

    [Fact]
    public void FolderWithAnInvalidManifest_IsNotAnInstall_AndGetsTheSubfolder()
    {
        _probe.File(DefaultDir + @"\" + InstallManifest.FileName, "CyberPad-Install 1\nversion=1\n..\\..\\victim.txt\n");
        InstallPathResult result = Evaluate(DefaultDir);
        Assert.Equal(InstallPathKind.UsesSubfolder, result.Kind);
        Assert.Equal(DefaultDir + @"\CyberPad", result.FullPath);
    }

    [Fact]
    public void ManifestThatIsALink_IsNotAnInstall()
    {
        _probe.Install(DefaultDir);
        _probe.ReparsePoints.Add(DefaultDir + @"\" + InstallManifest.FileName);
        Assert.Equal(InstallPathKind.UsesSubfolder, Evaluate(DefaultDir).Kind);
    }

    [Fact]
    public void FolderWithOtherFiles_UsesACyberPadSubfolder()
    {
        _probe.File(@"C:\Tools\readme.txt");
        InstallPathResult result = Evaluate(@"C:\Tools");
        Assert.True(result.IsUsable);
        Assert.Equal(InstallPathKind.UsesSubfolder, result.Kind);
        Assert.Equal(InstallPathKind.WillCreate, result.FolderKind);
        Assert.Equal(@"C:\Tools\CyberPad", result.FullPath);
        Assert.Equal("This folder will be created.", result.Message);
    }

    [Fact]
    public void Subfolder_ThatIsAnInstall_IsReportedAsAnUpdate()
    {
        _probe.File(@"C:\Tools\readme.txt").Install(@"C:\Tools\CyberPad");
        InstallPathResult result = Evaluate(@"C:\Tools\");
        Assert.Equal(InstallPathKind.UsesSubfolder, result.Kind);
        Assert.Equal(InstallPathKind.ExistingInstall, result.FolderKind);
        Assert.Equal("CyberPad is already installed here and will be updated.", result.Message);
    }

    [Fact]
    public void Subfolder_WithOtherFiles_IsRefused()
    {
        _probe.File(@"C:\Tools\readme.txt").File(@"C:\Tools\CyberPad\mine.txt");
        InstallPathResult result = Evaluate(@"C:\Tools");
        Assert.False(result.IsUsable);
        Assert.Equal(@"C:\Tools\CyberPad", result.FullPath);
        Assert.Equal(InstallMessages.SubfolderOccupied, result.Message);
    }

    [Fact]
    public void Subfolder_BreakingARule_ShowsThatRulesReason()
    {
        string dir = @"C:\" + new string('a', 172); // 175 characters; with "\CyberPad" 184
        _probe.File(dir + @"\x.txt");
        InstallPathResult result = Evaluate(dir);
        Assert.False(result.IsUsable);
        Assert.Equal("That path is too long or contains characters that cannot be used.", result.Message);
    }

    [Fact]
    public void Subfolder_ThatIsALink_IsRefused()
    {
        _probe.File(@"C:\Tools\readme.txt").Dir(@"C:\Tools\CyberPad");
        _probe.ReparsePoints.Add(@"C:\Tools\CyberPad");
        Assert.Equal(InstallMessages.Link, Evaluate(@"C:\Tools").Message);
    }

    [Theory]
    [InlineData(@"c:\users\U\appdata\local\programs\cyberpad")]
    [InlineData(@"C:\Users\u\AppData\Local\Programs\CyberPad\")]
    [InlineData(@"C:\Users\u\AppData\Local\Programs\CyberPad\\")]
    [InlineData(@"C:/Users/u/AppData/Local/Programs/CyberPad")]
    [InlineData(@"C:\Users/u\AppData/Local\Programs/CyberPad/")]
    [InlineData(@"C:\Users\\u\AppData\Local\Programs\CyberPad")]
    public void CaseSlashesAndTrailingSeparators_Normalise(string input)
    {
        InstallPathResult result = Evaluate(input);
        Assert.True(result.IsUsable, input);
        Assert.Equal(DefaultDir, result.FullPath, ignoreCase: true);
        Assert.DoesNotContain("/", result.FullPath);
        Assert.False(result.FullPath!.EndsWith('\\'));
    }

    // --- rule: a local fixed drive ---------------------------------------------------------------

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(@"\\server\share\CyberPad")]
    [InlineData(@"//server/share/CyberPad")]
    [InlineData(@"\/server\share\CyberPad")]
    [InlineData(@"\\?\C:\Users\u\AppData\Local\Programs\CyberPad")]
    [InlineData(@"\\.\C:\Users\u\CyberPad")]
    [InlineData(@"\??\C:\Users\u\CyberPad")]
    [InlineData(@"\\?\UNC\server\share\x")]
    [InlineData(@"\Users\u\CyberPad")]
    [InlineData(@"Programs\CyberPad")]
    [InlineData(@"..\..\CyberPad")]
    [InlineData(@"C:Programs\CyberPad")]
    [InlineData(@"C:")]
    [InlineData(@" C:\Tools\CyberPad")]
    [InlineData(@"1:\Tools\CyberPad")]
    public void NotALocalAbsolutePath_IsRefused(string? input) => AssertRefused(input, "Choose a folder on a local drive.");

    [Theory]
    [InlineData(DriveKind.Removable)]
    [InlineData(DriveKind.Network)]
    [InlineData(DriveKind.CdRom)]
    [InlineData(DriveKind.Ram)]
    [InlineData(DriveKind.Unknown)]
    public void NonFixedDrive_IsRefused(DriveKind kind)
    {
        _probe.Drives[@"E:\"] = kind;
        _probe.Dir(@"E:\Apps");
        AssertRefused(@"E:\Apps\CyberPad", "Choose a folder on a local drive.");
    }

    [Fact]
    public void MissingDrive_IsRefused() => AssertRefused(@"Q:\Apps\CyberPad", "Choose a folder on a local drive.");

    // --- rule: length and characters -------------------------------------------------------------

    [Fact]
    public void PathOf180Characters_IsAllowed_And181_IsRefused()
    {
        string at180 = @"C:\Tools\" + new string('b', 180 - 9);
        Assert.Equal(180, at180.Length);
        Assert.True(Evaluate(at180).IsUsable);

        string at181 = at180 + "c";
        AssertRefused(at181, "That path is too long or contains characters that cannot be used.");
    }

    [Fact]
    public void LongInputThatResolvesShort_IsStillRefused_WhenOverTheInputCap() =>
        AssertRefused(@"C:\Tools\" + string.Concat(Enumerable.Repeat(@"a\..\", 300)) + "CyberPad", InstallMessages.TooLongOrBadCharacters);

    [Theory]
    [InlineData("C:\\Tools\\Cyber\u0001Pad")]
    [InlineData("C:\\Tools\\Cyber\tPad")]
    [InlineData("C:\\Tools\\CyberPad\n")]
    [InlineData("C:\\Tools\\Cyber\u007FPad")]
    [InlineData("C:\\Tools\\Cyber\0Pad")]
    [InlineData(@"C:\Tools\CyberPad:stream")]
    [InlineData(@"C:\Tools\CyberPad::$DATA")]
    [InlineData(@"C:\Tools:x\CyberPad")]
    [InlineData(@"C:\Tools\CyberPad.")]
    [InlineData(@"C:\Tools\CyberPad ")]
    [InlineData(@"C:\Tools.\CyberPad")]
    [InlineData(@"C:\Tools \CyberPad")]
    [InlineData(@"C:\Tools\..\Windows\CyberPad")]
    [InlineData(@"C:\Users\u\..\..\Windows")]
    [InlineData(@"C:\Tools\.\CyberPad")]
    [InlineData(@"C:\Tools\...")]
    [InlineData(@"C:\Tools\CON")]
    [InlineData(@"C:\Tools\con")]
    [InlineData(@"C:\Tools\CON.txt")]
    [InlineData(@"C:\Tools\NUL\CyberPad")]
    [InlineData(@"C:\Tools\aux.cyberpad")]
    [InlineData(@"C:\Tools\PRN")]
    [InlineData(@"C:\Tools\COM1")]
    [InlineData(@"C:\Tools\com9.log")]
    [InlineData(@"C:\Tools\LPT1")]
    [InlineData(@"C:\Tools\Lpt9\x")]
    [InlineData("C:\\Tools\\COM\u00B9")]
    [InlineData(@"C:\Tools\CONIN$")]
    [InlineData(@"C:\Tools\CON .txt")]
    [InlineData(@"C:\Tools\Cyber?Pad")]
    [InlineData(@"C:\Tools\Cyber*Pad")]
    [InlineData(@"C:\Tools\<CyberPad>")]
    [InlineData(@"C:\Tools\Cyber|Pad")]
    [InlineData("C:\\Tools\\Cyber\"Pad")]
    [InlineData(@"C:\Tools\%TEMP%")]
    [InlineData(@"C:\Tools\50%off")]
    [InlineData(@"C:\PROGRA~1\CyberPad")]
    [InlineData(@"C:\Users\U~1\AppData\Local\CyberPad")]
    [InlineData(@"C:\Tools\CYBERP~1")]
    public void BadCharactersAndNames_AreRefused(string input) =>
        AssertRefused(input, "That path is too long or contains characters that cannot be used.");

    [Theory]
    [InlineData(@"C:\Tools\CONSOLE")]
    [InlineData(@"C:\Tools\COM10")]
    [InlineData(@"C:\Tools\LPT")]
    [InlineData(@"C:\Tools\my.CON")]
    [InlineData(@"C:\Tools\Cyber Pad")]
    [InlineData(@"C:\Tools\Cyber~Pad")]
    [InlineData(@"C:\Tools\Cyber & Pad ^1")]
    [InlineData(@"C:\Tools\.hidden")]
    public void LookAlikesOfReservedNames_AreAllowed(string input) => Assert.True(Evaluate(input).IsUsable, input);

    // --- rule: not a drive root or a shared folder -------------------------------------------------

    [Theory]
    [InlineData(@"C:\")]
    [InlineData(@"c:\")]
    [InlineData(@"C:/")]
    [InlineData(@"C:\\")]
    [InlineData(@"C:\Users\u")]
    [InlineData(@"c:\USERS\U\")]
    [InlineData(@"C:\Users\u\Desktop")]
    [InlineData(@"C:/Users/u/Desktop/")]
    [InlineData(@"C:\Users\u\Documents")]
    [InlineData(@"C:\users\u\documents\\")]
    [InlineData(@"C:\Users\u\Downloads")]
    [InlineData(@"C:\USERS\u\DOWNLOADS")]
    public void RootAndSharedFolders_AreRefused(string input) =>
        AssertRefused(input, "Choose a folder of its own for CyberPad, not a shared folder.");

    [Fact]
    public void FolderInsideDocuments_IsAllowed() => Assert.True(Evaluate(@"C:\Users\u\Documents\CyberPad").IsUsable);

    // --- rule: not the notes folder, inside it, or a parent of it --------------------------------

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad")]
    [InlineData(@"c:\users\u\appdata\local\cyberpad")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\")]
    [InlineData(@"C:/Users/u/AppData/Local/CyberPad/")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\sub")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\sub\deeper")]
    [InlineData(@"C:\Users\u\AppData\Local")]
    [InlineData(@"C:\Users\u\AppData\local\")]
    [InlineData(@"C:\Users\u\AppData")]
    [InlineData(@"C:\Users")]
    public void NotesFolder_ItsChildrenAndItsParents_AreRefused(string input) =>
        AssertRefused(input, "That folder holds your notes. Choose a different one.");

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPadX")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad2\sub")]
    [InlineData(@"C:\Users\u\AppData\Local\Cyber")]
    [InlineData(@"C:\Users\u\AppData\LocalLow\CyberPad")]
    public void LookAlikesOfTheNotesFolder_AreAllowed(string input) => Assert.True(Evaluate(input).IsUsable, input);

    // --- rule: not Windows or Program Files --------------------------------------------------------

    [Theory]
    [InlineData(@"C:\Windows")]
    [InlineData(@"C:\windows\System32\CyberPad")]
    [InlineData(@"C:\WINDOWS\")]
    [InlineData(@"C:\Program Files")]
    [InlineData(@"C:\Program Files\CyberPad")]
    [InlineData(@"c:\program files\cyberpad\")]
    [InlineData(@"C:\Program Files (x86)\CyberPad")]
    [InlineData(@"C:/Program Files (x86)/CyberPad")]
    public void AdminFolders_AreRefused(string input) =>
        AssertRefused(input, "That folder needs administrator rights. Choose a folder in your own profile.");

    [Theory]
    [InlineData(@"C:\Windows2\CyberPad")]
    [InlineData(@"C:\Program Files Extra\CyberPad")]
    public void LookAlikesOfAdminFolders_AreAllowed(string input) => Assert.True(Evaluate(input).IsUsable, input);

    // --- rule: no link or junction below the drive -------------------------------------------------

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\Programs")]
    [InlineData(@"C:\Users\u\AppData")]
    [InlineData(@"C:\Users")]
    public void LinkInTheMiddleOfThePath_IsRefused(string link)
    {
        _probe.ReparsePoints.Add(link);
        AssertRefused(DefaultDir, "That folder is a link to another location. Choose a real folder.");
    }

    [Fact]
    public void TargetFolderThatIsALink_IsRefused()
    {
        _probe.Dir(DefaultDir);
        _probe.ReparsePoints.Add(DefaultDir);
        AssertRefused(DefaultDir, InstallMessages.Link);
    }

    [Fact]
    public void RealJunctionInTheMiddleOfThePath_IsRefused()
    {
        using var temp = new InstallTempDir();
        string real = temp.Path_("real");
        Directory.CreateDirectory(real);
        temp.CreateJunction(temp.Path_("link"), real);
        InstallEnvironment env = TestEnvironments.Under(temp.Root);

        InstallPathResult viaLink = InstallPathPolicy.Evaluate(temp.Path_("link", "CyberPad"), new FileSystemProbe(), env);
        Assert.False(viaLink.IsUsable);
        Assert.Equal(InstallMessages.Link, viaLink.Message);

        InstallPathResult direct = InstallPathPolicy.Evaluate(temp.Path_("real", "CyberPad"), new FileSystemProbe(), env);
        Assert.Equal(InstallPathKind.WillCreate, direct.Kind);
        Assert.Empty(Directory.GetFileSystemEntries(real)); // the write test left nothing behind
    }

    // --- rule: setup can write there ---------------------------------------------------------------

    [Fact]
    public void ReadOnlyParent_IsRefused()
    {
        _probe.ReadOnlyDirs.Add(Programs);
        AssertRefused(DefaultDir, "Setup cannot write to that folder.");
    }

    [Fact]
    public void ReadOnlyEmptyFolder_IsRefused()
    {
        _probe.Dir(DefaultDir);
        _probe.ReadOnlyDirs.Add(DefaultDir);
        AssertRefused(DefaultDir, InstallMessages.CannotWrite);
    }

    [Fact]
    public void PathThatIsAFile_IsRefused()
    {
        _probe.File(DefaultDir);
        AssertRefused(DefaultDir, InstallMessages.CannotWrite);
    }

    [Fact]
    public void PathBelowAFile_IsRefused()
    {
        _probe.File(Programs + @"\file");
        AssertRefused(Programs + @"\file\CyberPad", InstallMessages.CannotWrite);
    }

    [Fact]
    public void FromSystem_ReadsTheRealFolders_WithoutChangingAnything()
    {
        InstallEnvironment env = InstallEnvironment.FromSystem(); // reads folder paths only
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData).TrimEnd('\\');
        Assert.Equal(local + @"\CyberPad", env.NotesFolder);
        Assert.Equal(local + @"\Programs\CyberPad", env.DefaultInstallFolder);
        Assert.NotNull(env.Downloads);
        Assert.Contains(env.Windows!, env.AdminFolders);
        Assert.Contains(env.UserProfile, env.SharedFolders);
    }

    [Fact]
    public void RulesApplyInTableOrder_LocalDriveBeforeCharacters()
    {
        AssertRefused("\\\\server\\share\\a\u0001b", InstallMessages.LocalDrive);
    }
}

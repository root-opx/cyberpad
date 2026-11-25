using System.Text.RegularExpressions;
using CyberPad.Install;

namespace CyberPad.Desktop.Tests;

public class SetupPlanTests
{
    [Fact]
    public void Fresh_install_shows_install_heading_default_folder_and_editable_field()
    {
        SetupPlan plan = SetupPlan.Create("1.2.3", null, @"C:\Users\x\AppData\Local\Programs\CyberPad");

        Assert.Equal("Install CyberPad 1.2.3", plan.Heading);
        Assert.Equal("Install", plan.ButtonText);
        Assert.Equal(@"C:\Users\x\AppData\Local\Programs\CyberPad", plan.Folder);
        Assert.False(plan.IsUpdate);
        Assert.Null(plan.FixedStatus);
    }

    [Fact]
    public void Existing_install_shows_update_heading_its_folder_and_the_fixed_line()
    {
        SetupPlan plan = SetupPlan.Create("1.2.3", @"D:\Apps\CyberPad", @"C:\default");

        Assert.Equal("Update CyberPad to 1.2.3", plan.Heading);
        Assert.Equal("Update", plan.ButtonText);
        Assert.Equal(@"D:\Apps\CyberPad", plan.Folder);
        Assert.True(plan.IsUpdate);
        Assert.Equal("CyberPad is already installed here and will be updated. To move it, uninstall it first.", plan.FixedStatus);
    }

    [Theory]
    [InlineData("1.0.0.0", "1.0.0")]
    [InlineData("2.14.7.0", "2.14.7")]
    [InlineData("3.1", "3.1.0")]
    public void Version_is_shown_with_three_parts(string assemblyVersion, string expected)
    {
        Assert.Equal(expected, SetupTexts.FormatVersion(Version.Parse(assemblyVersion)));
        Assert.True(InstallManifest.IsValidVersion(expected));
    }

    [Fact]
    public void Delete_notes_question_names_the_folder()
    {
        Assert.Equal(
            @"Delete all CyberPad notes and settings in C:\n\CyberPad? This cannot be undone.",
            SetupTexts.DeleteNotesQuestion(@"C:\n\CyberPad"));
    }

    [Fact]
    public void Error_line_has_the_type_name_only()
    {
        string line = SetupTexts.ErrorTypeLine(new InvalidOperationException(@"secret C:\Users\someone\x"));

        Assert.Equal("Error type: InvalidOperationException", line);
    }
}

public class UninstallStagesTests
{
    [Fact]
    public void No_arguments_is_the_first_stage()
    {
        Assert.Equal(UninstallStage.First, UninstallStages.Parse(Array.Empty<string>()));
        Assert.Equal(UninstallStage.First, UninstallStages.Parse(null));
    }

    [Fact]
    public void Exactly_stage2_is_the_second_stage()
    {
        Assert.Equal(UninstallStage.Second, UninstallStages.Parse(new[] { "--stage2" }));
    }

    [Theory]
    [InlineData("--STAGE2")]
    [InlineData("--stage2 ")]
    [InlineData("stage2")]
    [InlineData("-stage2")]
    [InlineData("")]
    [InlineData(@"C:\Users\x\CyberPad")]
    [InlineData("/silent")]
    public void Any_other_single_argument_is_invalid(string arg)
    {
        Assert.Equal(UninstallStage.Invalid, UninstallStages.Parse(new[] { arg }));
    }

    [Fact]
    public void More_than_one_argument_is_invalid()
    {
        Assert.Equal(UninstallStage.Invalid, UninstallStages.Parse(new[] { "--stage2", "--stage2" }));
        Assert.Equal(UninstallStage.Invalid, UninstallStages.Parse(new[] { "--stage2", @"C:\x" }));
        Assert.Equal(UninstallStage.Invalid, UninstallStages.Parse(new[] { @"C:\x", "--stage2" }));
    }

    [Fact]
    public void Temp_copy_name_is_prefix_32_hex_digits_and_exe()
    {
        byte[] random = Enumerable.Range(0, 16).Select(i => (byte)(i * 17 + 3)).ToArray();

        string name = UninstallStages.TempCopyName(random);

        Assert.Matches(new Regex(@"^CyberPad-Uninstall-[0-9a-f]{32}[.]exe$"), name);
        Assert.Equal("CyberPad-Uninstall-031425364758697a8b9cadbecfe0f102.exe", name);
    }

    [Fact]
    public void Different_random_bytes_give_different_names()
    {
        Assert.NotEqual(
            UninstallStages.TempCopyName(new byte[16]),
            UninstallStages.TempCopyName(Enumerable.Repeat((byte)255, 16).ToArray()));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(15)]
    [InlineData(17)]
    public void Temp_copy_name_needs_exactly_16_bytes(int length)
    {
        Assert.Throws<ArgumentException>(() => UninstallStages.TempCopyName(new byte[length]));
    }

    [Fact]
    public void Temp_copy_path_is_directly_inside_the_temp_folder()
    {
        string path = UninstallStages.TempCopyPath(@"C:\Temp", new byte[16]);

        Assert.Equal(@"C:\Temp", Path.GetDirectoryName(path));
        Assert.StartsWith("CyberPad-Uninstall-", Path.GetFileName(path));
    }
}

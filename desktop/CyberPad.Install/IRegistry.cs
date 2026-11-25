using System;
using System.Collections.Generic;

namespace CyberPad.Install
{
    /// <summary>The only registry keys the install code touches, all under HKEY_CURRENT_USER.</summary>
    public enum RegistryKeyId
    {
        /// <summary>The Settings → Apps uninstall entry. A root: deleting it deletes its subtree.</summary>
        UninstallEntry,

        /// <summary>The "Open with" application registration. A root: deleting it deletes its subtree.</summary>
        OpenWithApplication,

        /// <summary>The open command below <see cref="OpenWithApplication"/>.</summary>
        OpenWithCommand,

        /// <summary>The supported file types below <see cref="OpenWithApplication"/>.</summary>
        OpenWithSupportedTypes,
    }

    /// <summary>The fixed key paths, relative to HKEY_CURRENT_USER.</summary>
    public static class RegistryKeys
    {
        public const string UninstallEntryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CyberPad";
        public const string OpenWithApplicationPath = @"Software\Classes\Applications\CyberPad.exe";
        public const string OpenWithCommandPath = OpenWithApplicationPath + @"\shell\open\command";
        public const string OpenWithSupportedTypesPath = OpenWithApplicationPath + @"\SupportedTypes";

        /// <summary>Every key, parents before children.</summary>
        public static readonly RegistryKeyId[] All =
        {
            RegistryKeyId.UninstallEntry,
            RegistryKeyId.OpenWithApplication,
            RegistryKeyId.OpenWithCommand,
            RegistryKeyId.OpenWithSupportedTypes,
        };

        /// <summary>The two keys that may be deleted (with their subtrees).</summary>
        public static readonly RegistryKeyId[] Roots = { RegistryKeyId.UninstallEntry, RegistryKeyId.OpenWithApplication };

        public static string PathOf(RegistryKeyId key)
        {
            switch (key)
            {
                case RegistryKeyId.UninstallEntry:
                    return UninstallEntryPath;
                case RegistryKeyId.OpenWithApplication:
                    return OpenWithApplicationPath;
                case RegistryKeyId.OpenWithCommand:
                    return OpenWithCommandPath;
                case RegistryKeyId.OpenWithSupportedTypes:
                    return OpenWithSupportedTypesPath;
                default:
                    throw new ArgumentOutOfRangeException(nameof(key));
            }
        }

        public static bool IsRoot(RegistryKeyId key) =>
            key == RegistryKeyId.UninstallEntry || key == RegistryKeyId.OpenWithApplication;

        /// <summary>
        /// The keys that may be deleted with their subtrees: the two roots, and SupportedTypes (inside a
        /// root, for putting back an "Open with" entry that existed before setup).
        /// </summary>
        public static bool IsDeletable(RegistryKeyId key) => IsRoot(key) || key == RegistryKeyId.OpenWithSupportedTypes;

        /// <summary>Value names setup writes in the uninstall entry to remember an earlier "Open with" entry.</summary>
        public const string PreviousOpenCommandValue = "PreviousOpenCommand";

        public const string OpenWithExistedValue = "OpenWithExisted";

        public const string OpenWithAddedValue = "OpenWithAdded";
    }

    /// <summary>
    /// Registry access limited to the fixed keys in <see cref="RegistryKeys"/>; callers pass a key id,
    /// never a path. Values are strings or DWORDs.
    /// </summary>
    public interface IRegistry
    {
        bool KeyExists(RegistryKeyId key);

        /// <summary>The value names of the key, or an empty list when the key does not exist.</summary>
        IReadOnlyList<string> GetValueNames(RegistryKeyId key);

        /// <summary>A string or int value, or null when it is missing or of another kind. "" is the default value.</summary>
        object? GetValue(RegistryKeyId key, string name);

        /// <summary>Creates the key (and its parents) if it is missing.</summary>
        void CreateKey(RegistryKeyId key);

        /// <summary>Sets a string value, creating the key (and its parents) as needed.</summary>
        void SetString(RegistryKeyId key, string name, string value);

        /// <summary>Sets a DWORD value, creating the key (and its parents) as needed.</summary>
        void SetDword(RegistryKeyId key, string name, int value);

        /// <summary>
        /// Deletes a key allowed by <see cref="RegistryKeys.IsDeletable"/> and its subtree; does nothing when
        /// it is missing.
        /// </summary>
        void DeleteTree(RegistryKeyId root);

        /// <summary>Deletes one value; does nothing when the key or the value is missing.</summary>
        void DeleteValue(RegistryKeyId key, string name);
    }

    public sealed class ShortcutInfo
    {
        public ShortcutInfo(string targetPath, string workingDirectory, string iconPath)
        {
            TargetPath = targetPath;
            WorkingDirectory = workingDirectory;
            IconPath = iconPath;
        }

        public string TargetPath { get; }

        public string WorkingDirectory { get; }

        public string IconPath { get; }
    }

    /// <summary>The one Start menu shortcut, <c>%APPDATA%\Microsoft\Windows\Start Menu\Programs\CyberPad.lnk</c>.</summary>
    public interface IShortcuts
    {
        /// <summary>The current shortcut, or null when there is none.</summary>
        ShortcutInfo? TryRead();

        /// <summary>Creates or replaces the shortcut.</summary>
        void Create(ShortcutInfo shortcut);

        /// <summary>Deletes the shortcut; does nothing when there is none.</summary>
        void Delete();
    }

    /// <summary>Tells Explorer that file associations changed.</summary>
    public interface IShellNotify
    {
        void AssociationsChanged();
    }
}

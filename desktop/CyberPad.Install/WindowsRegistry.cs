using System;
using System.Collections.Generic;
using Microsoft.Win32;

namespace CyberPad.Install
{
    /// <summary>
    /// The real <see cref="IRegistry"/>: HKEY_CURRENT_USER (64-bit view) and only the fixed paths in
    /// <see cref="RegistryKeys"/>. Never exercised by the tests.
    /// </summary>
    public sealed class WindowsRegistry : IRegistry
    {
        public bool KeyExists(RegistryKeyId key)
        {
            using (RegistryKey hive = OpenHive())
            using (RegistryKey? k = hive.OpenSubKey(RegistryKeys.PathOf(key), false))
            {
                return k != null;
            }
        }

        public IReadOnlyList<string> GetValueNames(RegistryKeyId key)
        {
            using (RegistryKey hive = OpenHive())
            using (RegistryKey? k = hive.OpenSubKey(RegistryKeys.PathOf(key), false))
            {
                return k == null ? (IReadOnlyList<string>)Array.Empty<string>() : k.GetValueNames();
            }
        }

        public object? GetValue(RegistryKeyId key, string name)
        {
            using (RegistryKey hive = OpenHive())
            using (RegistryKey? k = hive.OpenSubKey(RegistryKeys.PathOf(key), false))
            {
                object? value = k?.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                if (k == null || value == null)
                {
                    return null; // checked first: GetValueKind throws for a missing value
                }

                RegistryValueKind kind = k.GetValueKind(name);
                return (kind == RegistryValueKind.String && value is string) || (kind == RegistryValueKind.DWord && value is int)
                    ? value
                    : null;
            }
        }

        public void CreateKey(RegistryKeyId key)
        {
            using (RegistryKey hive = OpenHive())
            using (hive.CreateSubKey(RegistryKeys.PathOf(key), true))
            {
            }
        }

        public void SetString(RegistryKeyId key, string name, string value) =>
            Set(key, name, value ?? throw new ArgumentNullException(nameof(value)), RegistryValueKind.String);

        public void SetDword(RegistryKeyId key, string name, int value) => Set(key, name, value, RegistryValueKind.DWord);

        public void DeleteTree(RegistryKeyId root)
        {
            if (!RegistryKeys.IsDeletable(root))
            {
                throw new ArgumentOutOfRangeException(nameof(root), "Only the root keys and SupportedTypes can be deleted.");
            }

            using (RegistryKey hive = OpenHive())
            {
                hive.DeleteSubKeyTree(RegistryKeys.PathOf(root), false);
            }
        }

        public void DeleteValue(RegistryKeyId key, string name)
        {
            if (name == null)
            {
                throw new ArgumentNullException(nameof(name));
            }

            using (RegistryKey hive = OpenHive())
            using (RegistryKey? k = hive.OpenSubKey(RegistryKeys.PathOf(key), true))
            {
                k?.DeleteValue(name, false);
            }
        }

        private static void Set(RegistryKeyId key, string name, object value, RegistryValueKind kind)
        {
            if (name == null)
            {
                throw new ArgumentNullException(nameof(name));
            }

            using (RegistryKey hive = OpenHive())
            using (RegistryKey k = hive.CreateSubKey(RegistryKeys.PathOf(key), true))
            {
                k.SetValue(name, value, kind);
            }
        }

        private static RegistryKey OpenHive() => RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
    }
}

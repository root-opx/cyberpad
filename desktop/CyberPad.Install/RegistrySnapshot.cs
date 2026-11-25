using System.Collections.Generic;

namespace CyberPad.Install
{
    /// <summary>
    /// The values of the fixed keys before setup changes them, so a failed run can put them back.
    /// Only string and DWORD values are kept; the install code writes no other kind.
    /// </summary>
    internal sealed class RegistrySnapshot
    {
        private readonly List<Item> _items = new List<Item>();
        private readonly HashSet<RegistryKeyId> _existingKeys = new HashSet<RegistryKeyId>();

        public static RegistrySnapshot Take(IRegistry registry)
        {
            var snapshot = new RegistrySnapshot();
            foreach (RegistryKeyId key in RegistryKeys.All)
            {
                if (!registry.KeyExists(key))
                {
                    continue;
                }

                snapshot._existingKeys.Add(key);
                foreach (string name in registry.GetValueNames(key))
                {
                    object? value = registry.GetValue(key, name);
                    if (value is string || value is int)
                    {
                        snapshot._items.Add(new Item(key, name, value));
                    }
                }
            }

            return snapshot;
        }

        /// <summary>Deletes both root keys, then writes back what was there before.</summary>
        public void Restore(IRegistry registry)
        {
            foreach (RegistryKeyId root in RegistryKeys.Roots)
            {
                registry.DeleteTree(root);
            }

            foreach (RegistryKeyId key in RegistryKeys.All)
            {
                if (_existingKeys.Contains(key))
                {
                    registry.CreateKey(key);
                }
            }

            foreach (Item item in _items)
            {
                if (item.Value is int number)
                {
                    registry.SetDword(item.Key, item.Name, number);
                }
                else
                {
                    registry.SetString(item.Key, item.Name, (string)item.Value);
                }
            }
        }

        private sealed class Item
        {
            public Item(RegistryKeyId key, string name, object value)
            {
                Key = key;
                Name = name;
                Value = value;
            }

            public RegistryKeyId Key { get; }

            public string Name { get; }

            public object Value { get; }
        }
    }
}

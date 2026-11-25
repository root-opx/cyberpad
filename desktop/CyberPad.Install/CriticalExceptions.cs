using System;
using System.Threading;

namespace CyberPad.Install
{
    internal static class CriticalExceptions
    {
        /// <summary>Exceptions that mean the process itself is in trouble; they are never caught and converted.</summary>
        public static bool IsCritical(Exception ex) =>
            ex is OutOfMemoryException || ex is StackOverflowException || ex is AccessViolationException || ex is ThreadAbortException;
    }
}

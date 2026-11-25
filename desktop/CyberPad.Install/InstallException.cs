using System;

namespace CyberPad.Install
{
    /// <summary>
    /// The one error type the install library throws. <see cref="Exception.Message"/> is always a
    /// user-safe sentence (what happened and what to do); it never carries a path from a hostile
    /// payload, a stack trace or an inner exception's text.
    /// </summary>
    public sealed class InstallException : Exception
    {
        public InstallException(string message) : base(message)
        {
        }

        public InstallException(string message, Exception inner) : base(message, inner)
        {
        }
    }
}

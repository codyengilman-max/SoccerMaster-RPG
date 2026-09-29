using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace SoccerMaster.Core.Serialization
{
    /// <summary>
    /// Minimal JSON reader/writer for the engine-free core: the tactical catalog, web-generated
    /// fixtures and the native save file all go through it. Values map to
    /// <c>Dictionary&lt;string, object&gt;</c>, <c>List&lt;object&gt;</c>, <c>string</c>, <c>double</c>,
    /// <c>bool</c> and <c>null</c>. Numbers round-trip with the shortest representation that
    /// reproduces the same double, matching what <c>JSON.stringify</c> writes.
    /// </summary>
    public static class Json
    {
        public static object Parse(string text)
        {
            var r = new Reader(text);
            r.SkipWs();
            object v = r.ReadValue();
            r.SkipWs();
            if (!r.AtEnd) throw r.Error("trailing characters");
            return v;
        }

        public static string Write(object value, bool pretty = false)
        {
            var sb = new StringBuilder();
            WriteValue(sb, value, pretty, 0);
            return sb.ToString();
        }

        // ------------------------------------------------------------------ typed access helpers

        public static Dictionary<string, object> Obj(object v, string where)
        {
            if (v is Dictionary<string, object> d) return d;
            throw new FormatException($"{where}: expected object, got {Describe(v)}");
        }

        public static List<object> Arr(object v, string where)
        {
            if (v is List<object> l) return l;
            throw new FormatException($"{where}: expected array, got {Describe(v)}");
        }

        public static string Str(object v, string where)
        {
            if (v is string s) return s;
            throw new FormatException($"{where}: expected string, got {Describe(v)}");
        }

        public static double Num(object v, string where)
        {
            if (v is double d) return d;
            throw new FormatException($"{where}: expected number, got {Describe(v)}");
        }

        public static bool Bool(object v, string where)
        {
            if (v is bool b) return b;
            throw new FormatException($"{where}: expected boolean, got {Describe(v)}");
        }

        public static object Get(Dictionary<string, object> o, string key, string where)
        {
            if (o.TryGetValue(key, out object v)) return v;
            throw new FormatException($"{where}: missing '{key}'");
        }

        public static object Opt(Dictionary<string, object> o, string key) => o.TryGetValue(key, out object v) ? v : null;

        public static string OptStr(Dictionary<string, object> o, string key) => Opt(o, key) is string s ? s : null;

        public static double OptNum(Dictionary<string, object> o, string key, double fallback) => Opt(o, key) is double d ? d : fallback;

        public static bool OptBool(Dictionary<string, object> o, string key, bool fallback) => Opt(o, key) is bool b ? b : fallback;

        private static string Describe(object v) => v == null ? "null" : v is Dictionary<string, object> ? "object" : v is List<object> ? "array" : v.GetType().Name;

        // ------------------------------------------------------------------ writer

        private static void WriteValue(StringBuilder sb, object v, bool pretty, int depth)
        {
            switch (v)
            {
                case null:
                    sb.Append("null");
                    break;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    break;
                case string s:
                    WriteString(sb, s);
                    break;
                case double d:
                    WriteNumber(sb, d);
                    break;
                case float f:
                    WriteNumber(sb, f);
                    break;
                case int i:
                    sb.Append(i.ToString(CultureInfo.InvariantCulture));
                    break;
                case long l:
                    sb.Append(l.ToString(CultureInfo.InvariantCulture));
                    break;
                case uint u:
                    sb.Append(u.ToString(CultureInfo.InvariantCulture));
                    break;
                case Dictionary<string, object> o:
                {
                    sb.Append('{');
                    bool first = true;
                    foreach (KeyValuePair<string, object> kv in o)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        if (pretty) Newline(sb, depth + 1);
                        WriteString(sb, kv.Key);
                        sb.Append(pretty ? ": " : ":");
                        WriteValue(sb, kv.Value, pretty, depth + 1);
                    }
                    if (pretty && !first) Newline(sb, depth);
                    sb.Append('}');
                    break;
                }
                case List<object> a:
                {
                    sb.Append('[');
                    for (int i = 0; i < a.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        if (pretty) Newline(sb, depth + 1);
                        WriteValue(sb, a[i], pretty, depth + 1);
                    }
                    if (pretty && a.Count > 0) Newline(sb, depth);
                    sb.Append(']');
                    break;
                }
                default:
                    throw new ArgumentException($"cannot serialize {v.GetType().Name}");
            }
        }

        private static void Newline(StringBuilder sb, int depth)
        {
            sb.Append('\n');
            for (int i = 0; i < depth; i++) sb.Append("  ");
        }

        /// <summary>
        /// JSON.stringify number semantics — non-finite becomes null, integers print without a
        /// fraction — except that negative zero is kept as <c>-0</c> so a saved state reloads bit-identical.
        /// </summary>
        public static void WriteNumber(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d))
            {
                sb.Append("null");
                return;
            }
            if (d == 0 && double.IsNegative(d))
            {
                sb.Append("-0");
                return;
            }
            if (d == Math.Floor(d) && Math.Abs(d) < 1e15)
            {
                sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
                return;
            }
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        public static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ------------------------------------------------------------------ reader

        private sealed class Reader
        {
            private readonly string _s;
            private int _i;

            public Reader(string s) { _s = s; }

            public bool AtEnd => _i >= _s.Length;

            public FormatException Error(string msg) => new FormatException($"JSON: {msg} at offset {_i}");

            public void SkipWs()
            {
                while (_i < _s.Length)
                {
                    char c = _s[_i];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') _i++;
                    else break;
                }
            }

            public object ReadValue()
            {
                if (AtEnd) throw Error("unexpected end");
                char c = _s[_i];
                switch (c)
                {
                    case '{': return ReadObject();
                    case '[': return ReadArray();
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber();
                        throw Error($"unexpected '{c}'");
                }
            }

            private void Expect(string word)
            {
                if (string.CompareOrdinal(_s, _i, word, 0, word.Length) != 0) throw Error($"expected {word}");
                _i += word.Length;
            }

            private Dictionary<string, object> ReadObject()
            {
                var o = new Dictionary<string, object>();
                _i++;
                SkipWs();
                if (!AtEnd && _s[_i] == '}') { _i++; return o; }
                while (true)
                {
                    SkipWs();
                    if (AtEnd || _s[_i] != '"') throw Error("expected key");
                    string key = ReadString();
                    SkipWs();
                    if (AtEnd || _s[_i] != ':') throw Error("expected ':'");
                    _i++;
                    SkipWs();
                    o[key] = ReadValue();
                    SkipWs();
                    if (AtEnd) throw Error("unterminated object");
                    if (_s[_i] == ',') { _i++; continue; }
                    if (_s[_i] == '}') { _i++; return o; }
                    throw Error("expected ',' or '}'");
                }
            }

            private List<object> ReadArray()
            {
                var a = new List<object>();
                _i++;
                SkipWs();
                if (!AtEnd && _s[_i] == ']') { _i++; return a; }
                while (true)
                {
                    SkipWs();
                    a.Add(ReadValue());
                    SkipWs();
                    if (AtEnd) throw Error("unterminated array");
                    if (_s[_i] == ',') { _i++; continue; }
                    if (_s[_i] == ']') { _i++; return a; }
                    throw Error("expected ',' or ']'");
                }
            }

            private string ReadString()
            {
                _i++;
                var sb = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw Error("unterminated string");
                    char c = _s[_i++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\')
                    {
                        sb.Append(c);
                        continue;
                    }
                    if (AtEnd) throw Error("bad escape");
                    char e = _s[_i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (_i + 4 > _s.Length) throw Error("bad \\u escape");
                            sb.Append((char)int.Parse(_s.Substring(_i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            _i += 4;
                            break;
                        default: throw Error($"bad escape '\\{e}'");
                    }
                }
            }

            private double ReadNumber()
            {
                int start = _i;
                if (_s[_i] == '-') _i++;
                while (_i < _s.Length && char.IsDigit(_s[_i])) _i++;
                if (_i < _s.Length && _s[_i] == '.')
                {
                    _i++;
                    while (_i < _s.Length && char.IsDigit(_s[_i])) _i++;
                }
                if (_i < _s.Length && (_s[_i] == 'e' || _s[_i] == 'E'))
                {
                    _i++;
                    if (_i < _s.Length && (_s[_i] == '+' || _s[_i] == '-')) _i++;
                    while (_i < _s.Length && char.IsDigit(_s[_i])) _i++;
                }
                string tok = _s.Substring(start, _i - start);
                if (!double.TryParse(tok, NumberStyles.Float, CultureInfo.InvariantCulture, out double d)) throw Error($"bad number '{tok}'");
                return d;
            }
        }
    }
}

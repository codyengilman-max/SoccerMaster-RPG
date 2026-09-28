using System;
using System.Collections.Generic;

namespace SoccerMaster.Core.Sim
{
    /// <summary>
    /// Deterministic PRNG (SplitMix32 variant), port of src/sim/rng.ts. Every random choice in
    /// the simulation goes through one instance so a seed reproduces a drill or match exactly,
    /// and the same seed reproduces the web oracle's stream bit for bit.
    /// </summary>
    public sealed class Rng
    {
        private uint _state;

        public Rng(double seed)
        {
            _state = JsMath.ToUint32(seed);
        }

        public Rng(int seed)
        {
            unchecked { _state = (uint)seed; }
        }

        /// <summary>Uniform in [0, 1).</summary>
        public double Next()
        {
            unchecked
            {
                _state = _state + 0x9e3779b9u;
                uint z = _state;
                z = JsMath.ImulU(z ^ (z >> 16), 0x85ebca6bu);
                z = JsMath.ImulU(z ^ (z >> 13), 0xc2b2ae35u);
                z = z ^ (z >> 16);
                return z / 4294967296.0;
            }
        }

        public double Range(double min, double max) => min + (max - min) * Next();

        public bool Chance(double p) => Next() < p;

        public int Int(int minInclusive, int maxExclusive) =>
            minInclusive + (int)Math.Floor(Next() * (maxExclusive - minInclusive));

        public T Pick<T>(IReadOnlyList<T> items)
        {
            if (items.Count == 0) throw new InvalidOperationException("pick from empty list");
            return items[Int(0, items.Count)];
        }

        /// <summary>Approximately normal, mean 0, sd 1 (sum of uniforms).</summary>
        public double Gaussian()
        {
            double s = 0;
            for (int i = 0; i < 6; i++) s += Next();
            return (s - 3) * 1.4142;
        }

        public uint Snapshot() => _state;

        public void Restore(uint state) => _state = state;

        /// <summary>FNV-1a of the UTF-16 code units, port of <c>hashSeed</c>.</summary>
        public static uint HashSeed(string text)
        {
            unchecked
            {
                uint h = 2166136261u;
                foreach (char c in text)
                {
                    h ^= c;
                    h = JsMath.ImulU(h, 16777619u);
                }
                return h;
            }
        }
    }
}

# Use an append-only causal event model

The Trace will use immutable normalized Events as its source of truth, preserving causal parent-child relationships and sequence within each event source without inventing a total order across concurrent agents. Mutable spans would simplify some terminal views and a graph would favor the planned visualization, but both can instead be derived as projections from an event stream that supports live collection, replay, and protocol evolution.

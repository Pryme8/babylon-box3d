# Pyramid stability (node, 2026-09-15)

Same setup as the benchmark (Babylon.js 8.56.2 defaults, fixed 1/60 s step, sleep on). `top` is the top box height as a fraction of its start height, drift is how far boxes moved from their start positions in meters. Produced by `node --import tsx bench/diagnose-pyramid.ts 20,30,35,40,50,100`.

```
rows  20 box3d 10s: top 1.00 mean drift 0.01 max 0.03 | 30s: top 1.00 mean drift 0.01 max 0.03
rows  20 havok 10s: top 1.00 mean drift 0.02 max 0.07 | 30s: top 1.00 mean drift 0.02 max 0.07
rows  30 box3d 10s: top 1.00 mean drift 0.03 max 0.06 | 30s: top 1.00 mean drift 0.03 max 0.06
rows  30 havok 10s: top 0.97 mean drift 0.45 max 5.16 | 30s: top 0.02 mean drift 11.79 max 36.17
rows  35 box3d 10s: top 1.00 mean drift 0.04 max 0.08 | 30s: top 1.00 mean drift 0.04 max 0.08
rows  35 havok 10s: top 0.99 mean drift 0.40 max 1.73 | 30s: top -28.46 mean drift 16.75 max 1036.63
rows  40 box3d 10s: top 1.00 mean drift 0.05 max 0.11 | 30s: top 1.00 mean drift 0.05 max 0.11
rows  40 havok 10s: top 0.36 mean drift 6.22 max 28.80 | 30s: top 0.01 mean drift 14.11 max 57.93
rows  50 box3d 10s: top 1.00 mean drift 0.08 max 0.17 | 30s: top 1.00 mean drift 0.08 max 0.17
rows  50 havok 10s: top 0.05 mean drift 10.16 max 52.80 | 30s: top 0.01 mean drift 18.48 max 60.19
rows 100 box3d 10s: top 0.99 mean drift 0.34 max 0.69 | 30s: top 0.99 mean drift 0.34 max 0.69
rows 100 havok 10s: top 0.05 mean drift 33.82 max 101.76 | 30s: top 0.05 mean drift 33.84 max 101.86
```

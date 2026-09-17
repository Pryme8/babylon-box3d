# Physics benchmark (node, 2026-09-17)

CPU: AMD Ryzen 9 5900X 12-Core Processor (24 logical cores), win32 10.0.26200, node v24.13.0
Babylon.js 9.26.1, @babylonjs/havok 1.3.14, oimo 1.0.9, box3d 47d7f7cc7e09
Time step 1/60 s fixed, one step per call. engine defaults (Box3D 4 sub steps, Havok defaults, Oimo 8 iterations), friction 0.6, restitution 0, density 1000. Median of 3 runs.
Box3D on the threaded build with 8 workers (the calling thread and 7 others). Havok and Oimo are single threaded.

| Scene | Bodies | Engine | Sleep | Step mean (ms) | p95 | max | Engine only mean | Build (ms) | Result |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Pyramid, 20 rows | 210 | Box3D x8 | on | 0.11 | 0.87 | 1.77 | 0.09 | 12 | standing, top at 100% height |
| Pyramid, 20 rows | 210 | Box3D x8 | off | 0.50 | 0.66 | 1.82 | 0.46 | 6 | standing, top at 100% height |
| Pyramid, 50 rows | 1275 | Box3D x8 | on | 0.34 | 1.74 | 5.25 | 0.27 | 17 | standing, top at 100% height |
| Pyramid, 50 rows | 1275 | Box3D x8 | off | 1.80 | 2.35 | 4.95 | 1.50 | 21 | standing, top at 100% height |
| Pyramid, 100 rows | 5050 | Box3D x8 | on | 5.72 | 7.75 | 18.20 | 4.04 | 86 | standing, top at 99% height |
| Pyramid, 100 rows | 5050 | Box3D x8 | off | 7.91 | 10.18 | 21.26 | 5.31 | 103 | standing, top at 99% height |
| Pile, 1000 boxes and spheres | 1000 | Box3D x8 | on | 1.65 | 2.53 | 5.05 | 1.44 | 22 | 0 escaped |
| Pile, 1000 boxes and spheres | 1000 | Box3D x8 | off | 1.58 | 2.26 | 3.76 | 1.37 | 16 | 0 escaped |
| Pile, 4000 boxes and spheres | 4000 | Box3D x8 | on | 6.31 | 8.44 | 33.36 | 4.79 | 74 | 0 escaped |
| Pile, 4000 boxes and spheres | 4000 | Box3D x8 | off | 5.20 | 7.02 | 22.61 | 4.09 | 51 | 0 escaped |

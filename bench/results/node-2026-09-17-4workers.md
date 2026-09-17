# Physics benchmark (node, 2026-09-17)

CPU: AMD Ryzen 9 5900X 12-Core Processor (24 logical cores), win32 10.0.26200, node v24.13.0
Babylon.js 9.26.1, @babylonjs/havok 1.3.14, oimo 1.0.9, box3d 47d7f7cc7e09
Time step 1/60 s fixed, one step per call. engine defaults (Box3D 4 sub steps, Havok defaults, Oimo 8 iterations), friction 0.6, restitution 0, density 1000. Median of 3 runs.
Box3D on the threaded build with 4 workers (the calling thread and 3 others). Havok and Oimo are single threaded.

| Scene | Bodies | Engine | Sleep | Step mean (ms) | p95 | max | Engine only mean | Build (ms) | Result |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Pyramid, 20 rows | 210 | Box3D x4 | on | 0.05 | 0.37 | 1.36 | 0.04 | 8 | standing, top at 100% height |
| Pyramid, 20 rows | 210 | Box3D x4 | off | 0.40 | 0.57 | 0.98 | 0.37 | 4 | standing, top at 100% height |
| Pyramid, 50 rows | 1275 | Box3D x4 | on | 0.42 | 2.22 | 6.10 | 0.35 | 19 | standing, top at 100% height |
| Pyramid, 50 rows | 1275 | Box3D x4 | off | 1.76 | 2.84 | 4.68 | 1.52 | 22 | standing, top at 100% height |
| Pyramid, 100 rows | 5050 | Box3D x4 | on | 7.55 | 11.33 | 21.68 | 5.81 | 85 | standing, top at 99% height |
| Pyramid, 100 rows | 5050 | Box3D x4 | off | 9.15 | 12.99 | 20.85 | 7.07 | 105 | standing, top at 99% height |
| Pile, 1000 boxes and spheres | 1000 | Box3D x4 | on | 1.38 | 2.17 | 5.76 | 1.25 | 22 | 0 escaped |
| Pile, 1000 boxes and spheres | 1000 | Box3D x4 | off | 1.13 | 1.70 | 4.33 | 1.03 | 11 | 0 escaped |
| Pile, 4000 boxes and spheres | 4000 | Box3D x4 | on | 7.21 | 10.77 | 27.05 | 5.84 | 42 | 0 escaped |
| Pile, 4000 boxes and spheres | 4000 | Box3D x4 | off | 9.90 | 13.50 | 29.97 | 7.90 | 69 | 0 escaped |

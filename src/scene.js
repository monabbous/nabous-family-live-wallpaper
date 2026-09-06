(() => {
  "use strict";

  const DEFAULT_IMAGE = "../assets/wallpaper.png"
  const ART_W = 1672;
  const ART_H = 941;
  const TAU = Math.PI * 2;

  const byId = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing required element: #${id}`);
    return element;
  };

  const canvas = byId("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2D canvas context is unavailable.");

  const hud = byId("hud");
  const mini = byId("mini");

  const controls = {
    intensity: byId("intensity"),
    speed: byId("speed"),
    shipCount: byId("shipCount"),
    lanternStrength: byId("lanternStrength"),
    lanternRadius: byId("lanternRadius"),
    fogStrength: byId("fogStrength"),
    fogFlowSpeed: byId("fogFlowSpeed"),
    vaporStrength: byId("vaporStrength"),
    vaporWidth: byId("vaporWidth"),
    lights: byId("lights"),
    ships: byId("ships"),
    haze: byId("haze"),
    waterfalls: byId("waterfalls"),
    lanterns: byId("lanterns"),
    petals: byId("petals"),
    mugVapor: byId("mugVapor"),
    depthOcclusion: byId("depthOcclusion"),
    showDepth: byId("showDepth"),
    showAnchors: byId("showAnchors"),
    showFogDetection: byId("showFogDetection"),
    showMugDetection: byId("showMugDetection"),
  };

  const readouts = {
    intensity: byId("intensityValue"),
    speed: byId("speedValue"),
    shipCount: byId("shipCountValue"),
    lanternStrength: byId("lanternStrengthValue"),
    lanternRadius: byId("lanternRadiusValue"),
    fogStrength: byId("fogStrengthValue"),
    fogFlowSpeed: byId("fogFlowSpeedValue"),
    vaporStrength: byId("vaporStrengthValue"),
    vaporWidth: byId("vaporWidthValue"),
    fps: byId("fpsReadout"),
  };

  let cssW = 0, cssH = 0, dpr = 1;
  let paused = false;
  let hidden = true;
  let frameHandle = 0;
  let lastFrame = performance.now();
  let simTime = 0;
  let measuredFrames = 0;
  let measuredAt = performance.now();

  // 30 FPS is intentional: subtle motion with lower power draw.
  const TARGET_FPS = 30;
  const FRAME_MS = 1000 / TARGET_FPS;

  const background = new Image();
  background.decoding = "async";
  let sourceW = ART_W, sourceH = ART_H;
  background.src = DEFAULT_IMAGE;

  // ---------- Deterministic pseudo-random ----------
  let seedState = 0x9e3779b9;
  function rnd() {
    seedState ^= seedState << 13;
    seedState ^= seedState >>> 17;
    seedState ^= seedState << 5;
    return ((seedState >>> 0) / 4294967296);
  }
  function range(a, b) { return a + (b - a) * rnd(); }
  function choose(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------- Artwork-aware effect zones ----------
  // Coordinates are in the native 1672x941 artwork coordinate system.
  // Effects intentionally avoid the family area in the lower-left.
  const LIGHT_ZONES = [
    [690, 125, 900, 390],
    [900, 110, 1160, 510],
    [1110, 120, 1360, 570],
    [1330, 80, 1650, 650],
    [780, 470, 1180, 720],
    [1180, 500, 1630, 770],
  ];

  const SHIP_LANES = [
    // The family occupies the nearest left foreground; visible traffic begins
    // in the actual city corridor. Ships may still pass behind/in front of
    // skyline structures according to their z layer.
    { y: 258, x0: 690, x1: 1745, dir: -1, depth: .74 },
    { y: 326, x0: 705, x1: 1740, dir:  1, depth: .60 },
    { y: 402, x0: 720, x1: 1740, dir: -1, depth: .48 },
    { y: 488, x0: 755, x1: 1745, dir:  1, depth: .38 },
  ];

  // ---------- Pixel-derived scene depth ----------
  // Unlike the previous hand-drawn polygons, this depth map is inferred from
  // the artwork itself. The important distinction is:
  //
  //   level 0 = sky / open atmosphere
  //   level 1 = distant terrain / skyline
  //   level 2 = structural city mass
  //   level 3 = near architecture / foreground
  //
  // Ships still carry zLayer 0..2. A sprite pixel is hidden only when the
  // artwork pixel underneath belongs to a *closer* inferred depth level.
  //
  // The map is intentionally built at ~1/2 resolution and sampled nearest-
  // neighbour. That makes the boundaries feel compatible with the pixel art
  // and keeps the one-time analysis inexpensive.
  const depthCanvas = document.createElement("canvas");
  const depthCtx = depthCanvas.getContext("2d", { willReadFrequently:true });
  const depthDebugCanvas = document.createElement("canvas");
  const depthDebugCtx = depthDebugCanvas.getContext("2d");

  let depthLevels = null;
  let depthMapW = 0;
  let depthMapH = 0;
  let depthToSourceX = 1;
  let depthToSourceY = 1;

  // ---------- Foreground / terrace guard ----------
  // Automatic single-image depth is weakest on the foreground family because
  // skin, cloth, plants and the terrace contain colors that also occur in the
  // distant city. For THIS artwork we add a conservative hand-traced semantic
  // guard around the nearest composition. The mask is used only as a "near"
  // override; all city depth still comes from the pixel-derived classifier.
  //
  // Coordinates are native artwork pixels (1672 × 941). The polygons follow
  // the visible silhouette rather than filling large rectangles.
  const FOREGROUND_GUARD = [
    // Left architectural wall / window / hanging structure.
    [
      [0,0],[493,0],[493,160],[516,160],[516,272],[533,272],
      [533,349],[493,349],[478,411],[420,425],[342,413],[258,423],
      [154,443],[0,444]
    ],

    // Family + chair / blanket silhouette. Kept as one near foreground mass
    // because ships should never visually cross any of these people.
    [
      [168,941],[82,850],[76,728],[103,617],[130,533],[155,455],
      [195,380],[243,325],[302,302],[344,308],[377,339],
      [404,369],[438,350],[463,315],[507,294],[556,300],[598,328],
      [620,366],[628,404],[669,425],[711,451],[747,485],[770,535],
      [770,592],[797,631],[807,687],[790,741],[824,795],[860,941]
    ],

    // Foreground table / lantern / lower-left terrace blocks.
    [
      [0,624],[95,624],[95,600],[222,600],[222,624],[340,624],
      [340,688],[505,688],[505,755],[578,755],[578,941],[0,941]
    ],

    // Nearest lower terrace / balcony plane across the bottom.
    [
      [560,941],[560,790],[650,790],[650,754],[746,754],[746,727],
      [866,727],[866,708],[1008,708],[1008,690],[1132,690],[1132,674],
      [1266,674],[1266,656],[1407,656],[1407,623],[1672,623],[1672,941]
    ],

    // Right-front architectural mass.
    [
      [1484,941],[1484,548],[1510,548],[1510,515],[1560,515],[1560,480],
      [1607,480],[1607,451],[1672,451],[1672,941]
    ]
  ];

  function pointInPolygon(px,py,poly) {
    let inside=false;
    for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
      const xi=poly[i][0], yi=poly[i][1];
      const xj=poly[j][0], yj=poly[j][1];
      const crosses=((yi>py)!==(yj>py)) &&
        (px < (xj-xi)*(py-yi)/((yj-yi)||1e-6)+xi);
      if (crosses) inside=!inside;
    }
    return inside;
  }

  function foregroundGuardAtNative(x,y) {
    for (const poly of FOREGROUND_GUARD) {
      if (pointInPolygon(x,y,poly)) return true;
    }
    return false;
  }

  function applyForegroundGuardToDepth() {
    if (!depthLevels) return;

    // Rasterize at the depth-map resolution. This guarantees that the exact
    // same mask drives both debug rendering and ship occlusion.
    for (let dy=0;dy<depthMapH;dy++) {
      const sy=(dy+.5)*depthToSourceY;
      for (let dx=0;dx<depthMapW;dx++) {
        const sx=(dx+.5)*depthToSourceX;
        if (foregroundGuardAtNative(sx,sy)) {
          depthLevels[dy*depthMapW+dx]=3;
        }
      }
    }
  }

  function buildDepthMap() {
    const targetW = Math.min(860, sourceW);
    const scanScale = targetW / sourceW;

    depthMapW = Math.max(64, Math.round(sourceW * scanScale));
    depthMapH = Math.max(64, Math.round(sourceH * scanScale));
    depthToSourceX = sourceW / depthMapW;
    depthToSourceY = sourceH / depthMapH;

    depthCanvas.width = depthMapW;
    depthCanvas.height = depthMapH;
    depthCtx.clearRect(0,0,depthMapW,depthMapH);
    depthCtx.imageSmoothingEnabled = false;
    depthCtx.drawImage(background,0,0,depthMapW,depthMapH);

    let pixels;
    try {
      pixels = depthCtx.getImageData(0,0,depthMapW,depthMapH).data;
    } catch (_) {
      depthLevels = null;
      return;
    }

    const n = depthMapW * depthMapH;
    const lum = new Float32Array(n);
    const rr = new Uint8Array(n);
    const gg = new Uint8Array(n);
    const bb = new Uint8Array(n);
    const edge = new Float32Array(n);
    const texture = new Float32Array(n);
    let solid = new Uint8Array(n);

    // Base color/luminance.
    for (let i=0;i<n;i++) {
      const p=i*4;
      const r=pixels[p], g=pixels[p+1], b=pixels[p+2];
      rr[i]=r; gg[i]=g; bb[i]=b;
      lum[i]=.2126*r + .7152*g + .0722*b;
    }

    // Local edge magnitude. Architecture in this painting is much more
    // high-frequency than the hazy mountains / atmosphere behind it.
    for (let y=1;y<depthMapH-1;y++) {
      for (let x=1;x<depthMapW-1;x++) {
        const i=y*depthMapW+x;
        const gx=Math.abs(lum[i+1]-lum[i-1]);
        const gy=Math.abs(lum[i+depthMapW]-lum[i-depthMapW]);
        edge[i]=gx+gy;
      }
    }

    // 7x7 box average of edge magnitude using an integral image.
    const iw=depthMapW+1;
    const integral=new Float64Array((depthMapW+1)*(depthMapH+1));
    for (let y=0;y<depthMapH;y++) {
      let row=0;
      for (let x=0;x<depthMapW;x++) {
        row+=edge[y*depthMapW+x];
        integral[(y+1)*iw+(x+1)] =
          integral[y*iw+(x+1)] + row;
      }
    }
    function edgeAverage(x,y,rad=3) {
      const x0=Math.max(0,x-rad), y0=Math.max(0,y-rad);
      const x1=Math.min(depthMapW-1,x+rad), y1=Math.min(depthMapH-1,y+rad);
      const A=integral[y0*iw+x0];
      const B=integral[y0*iw+(x1+1)];
      const C=integral[(y1+1)*iw+x0];
      const D=integral[(y1+1)*iw+(x1+1)];
      return (D-B-C+A)/((x1-x0+1)*(y1-y0+1));
    }

    for (let y=0;y<depthMapH;y++) {
      const yn=y/Math.max(1,depthMapH-1);

      for (let x=0;x<depthMapW;x++) {
        const i=y*depthMapW+x;
        const r=rr[i], g=gg[i], b=bb[i], L=lum[i];
        const tex=edgeAverage(x,y,3);
        texture[i]=tex;

        // Warm sunset/cloud colors and smooth upper-purple atmosphere are
        // treated as open background even if a particular cloud is dark.
        const warmSky =
          r>55 &&
          r>g*1.17 &&
          r>b*.84 &&
          yn<.64;

        const purpleAtmosphere =
          yn<.40 &&
          r>48 && b>46 &&
          g<Math.max(r,b)*.84 &&
          tex<28;

        const openAtmosphere = warmSky || purpleAtmosphere;

        // Dark structure, or medium-dark highly textured structure.
        // Smooth distant mountains still enter the map, but only as level 1.
        if (
          !openAtmosphere &&
          (
            L<91 ||
            (L<137 && tex>28)
          )
        ) {
          solid[i]=1;
        }
      }
    }

    // Two conservative morphology passes:
    // fill small window/light holes inside buildings, then remove isolated
    // single-pixel detections in the sky.
    function neighbourCount(mask,x,y) {
      let c=0;
      for (let oy=-1;oy<=1;oy++) {
        for (let ox=-1;ox<=1;ox++) {
          if (!ox && !oy) continue;
          const nx=x+ox, ny=y+oy;
          if (nx<0||ny<0||nx>=depthMapW||ny>=depthMapH) continue;
          c+=mask[ny*depthMapW+nx];
        }
      }
      return c;
    }

    for (let pass=0;pass<2;pass++) {
      const next=solid.slice();
      for (let y=1;y<depthMapH-1;y++) {
        for (let x=1;x<depthMapW-1;x++) {
          const i=y*depthMapW+x;
          const c=neighbourCount(solid,x,y);
          if (!solid[i] && c>=6) next[i]=1;
          if (solid[i] && c<=1) next[i]=0;
        }
      }
      solid=next;
    }

    // Measure how far each solid pixel belongs to a continuous object in the
    // vertical and horizontal directions. This is the core of the depth
    // estimate: a skyline mountain is usually smooth/low-texture; a building
    // has sustained vertical structure; a near building is both substantial
    // and visually textured.
    const up=new Uint16Array(n);
    const down=new Uint16Array(n);
    const left=new Uint16Array(n);
    const right=new Uint16Array(n);

    for (let x=0;x<depthMapW;x++) {
      let run=0;
      for (let y=0;y<depthMapH;y++) {
        const i=y*depthMapW+x;
        run=solid[i]?run+1:0;
        up[i]=run;
      }
      run=0;
      for (let y=depthMapH-1;y>=0;y--) {
        const i=y*depthMapW+x;
        run=solid[i]?run+1:0;
        down[i]=run;
      }
    }

    for (let y=0;y<depthMapH;y++) {
      let run=0;
      for (let x=0;x<depthMapW;x++) {
        const i=y*depthMapW+x;
        run=solid[i]?run+1:0;
        left[i]=run;
      }
      run=0;
      for (let x=depthMapW-1;x>=0;x--) {
        const i=y*depthMapW+x;
        run=solid[i]?run+1:0;
        right[i]=run;
      }
    }

    depthLevels=new Uint8Array(n);

    for (let y=0;y<depthMapH;y++) {
      const yn=y/Math.max(1,depthMapH-1);

      for (let x=0;x<depthMapW;x++) {
        const i=y*depthMapW+x;
        if (!solid[i]) continue;

        const xn=x/Math.max(1,depthMapW-1);
        const v=up[i]+down[i]-1;
        const h=left[i]+right[i]-1;
        const tex=texture[i];

        // Anything solid starts as far-background geometry.
        let level=1;

        // Mid-depth architecture:
        // require sustained geometry PLUS texture. This leaves most hazy
        // mountain silhouettes at level 1.
        const structural =
          (v>17 && tex>19) ||
          (h>22 && v>10 && tex>24) ||
          (v>10 && h>10 && tex>33);

        if (structural) level=2;

        // Near-depth is deliberately harder to earn. The central skyline's
        // thin distant towers therefore remain level 1/2 instead of being
        // mistaken for foreground simply because they are tall.
        const substantial =
          v>35 && h>14 && tex>28;

        const largeMass =
          v>24 && h>34 && tex>24 && yn>.28;

        if (substantial || largeMass) level=3;

        // Near foreground is applied later by a traced semantic guard.
        // Keep this classifier focused on the city/terrain itself.

        // Distant thin central spires should never become "near" just because
        // they have long vertical runs.
        if (
          xn>.34 && xn<.86 &&
          yn<.43 &&
          h<17
        ) {
          level=Math.min(level,2);
        }

        // Very smooth terrain is always far, even low in the frame.
        if (tex<15 && yn<.64) level=1;

        depthLevels[i]=level;
      }
    }

    // One median-like majority pass to remove 1-cell depth chatter without
    // blurring the object silhouettes into rectangular masks.
    const smoothed=depthLevels.slice();
    for (let y=1;y<depthMapH-1;y++) {
      for (let x=1;x<depthMapW-1;x++) {
        const i=y*depthMapW+x;
        if (!depthLevels[i]) continue;

        const counts=[0,0,0,0];
        for (let oy=-1;oy<=1;oy++) {
          for (let ox=-1;ox<=1;ox++) {
            counts[depthLevels[(y+oy)*depthMapW+(x+ox)]]++;
          }
        }

        let best=depthLevels[i], bestCount=counts[best];
        for (let d=1;d<=3;d++) {
          if (counts[d]>bestCount) {
            best=d;
            bestCount=counts[d];
          }
        }
        if (bestCount>=5) smoothed[i]=best;
      }
    }
    depthLevels=smoothed;

    // Correct the nearest family/terrace layer using the artwork-specific
    // traced silhouette. This prevents ships from crossing faces, clothing,
    // the chair, front table, terrace and near-right architecture.
    applyForegroundGuardToDepth();

    // Build a color-coded debug texture once.
    depthDebugCanvas.width=depthMapW;
    depthDebugCanvas.height=depthMapH;
    const debugImage=depthDebugCtx.createImageData(depthMapW,depthMapH);
    const dd=debugImage.data;

    for (let i=0;i<n;i++) {
      const d=depthLevels[i];
      if (!d) continue;
      const p=i*4;

      if (d===1) {
        dd[p]=72; dd[p+1]=135; dd[p+2]=255; dd[p+3]=118;
      } else if (d===2) {
        dd[p]=166; dd[p+1]=91; dd[p+2]=255; dd[p+3]=126;
      } else {
        dd[p]=255; dd[p+1]=75; dd[p+2]=142; dd[p+3]=134;
      }
    }
    depthDebugCtx.putImageData(debugImage,0,0);
  }

  function sceneDepthAt(x,y) {
    if (!depthLevels || !controls.depthOcclusion.checked) return 0;

    const dx=Math.round(x/depthToSourceX);
    const dy=Math.round(y/depthToSourceY);

    if (dx<0||dy<0||dx>=depthMapW||dy>=depthMapH) return 0;
    return depthLevels[dy*depthMapW+dx] || 0;
  }

  function maxSceneDepthAround(x,y,radius=5) {
    if (!depthLevels) return 0;

    const cx=Math.round(x/depthToSourceX);
    const cy=Math.round(y/depthToSourceY);
    const rx=Math.max(1,Math.ceil(radius/depthToSourceX));
    const ry=Math.max(1,Math.ceil(radius/depthToSourceY));

    let best=0;
    for (let yy=cy-ry;yy<=cy+ry;yy++) {
      if (yy<0||yy>=depthMapH) continue;
      for (let xx=cx-rx;xx<=cx+rx;xx++) {
        if (xx<0||xx>=depthMapW) continue;
        best=Math.max(best,depthLevels[yy*depthMapW+xx]||0);
        if (best===3) return 3;
      }
    }
    return best;
  }

  function drawDepthDebug() {
    if (!controls.showDepth.checked || !depthLevels) return;

    ctx.save();
    ctx.imageSmoothingEnabled=false;
    ctx.globalAlpha=.48;
    ctx.drawImage(
      depthDebugCanvas,
      0,0,depthMapW,depthMapH,
      0,0,sourceW,sourceH
    );
    ctx.restore();
  }



  // Populated from the image itself during analyzeScene().
  let waterfallRegions = [];
  let waterfallCellMask = null;

  // Fallback only. Normal operation snaps animation to emitters discovered
  // directly from the artwork pixels.
  const FALLBACK_LANTERNS = [
    { x: 95,   y: 286, outer: 94,  mid: 46, core: 14, phase: .3,  power: .72 },
    { x: 492,  y: 795, outer: 92,  mid: 44, core: 13, phase: 2.2, power: .78 },
    { x: 1437, y: 735, outer: 125, mid: 58, core: 16, phase: 4.7, power: 1.0 },
  ];

  let lanternEmitters = [];
  let sceneAnchorsReady = false;
  const analysisStatus = byId("analysisStatus");


  const lights = [];
  const ships = [];
  const hazePuffs = [];
  const navigationAnchors = [];

  let foliageRegions = [];
  let mugSteamSource = null;
  let fallingPetals = [];
  let fogFlows = [];
  let fogSprite = null;

  function createFallbackLight(i) {
    const z = choose(LIGHT_ZONES);
    return {
      x: range(z[0], z[2]),
      y: range(z[1], z[3]),
      size: choose([1,1,1,1,2]),
      kind: rnd() < .36 ? "cyan" : "red",
      rate: range(.22, .72),
      phase: range(0, TAU),
      duty: range(2.5, 7.0),
      base: range(.08, .22),
    };
  }

  function randomShipDepth(lane) {
    const r = rnd();
    // Higher lanes skew farther away; lower lanes admit more near traffic.
    if (lane.y < 290) return r < .64 ? 0 : r < .91 ? 1 : 2;
    if (lane.y < 370) return r < .48 ? 0 : r < .84 ? 1 : 2;
    if (lane.y < 450) return r < .34 ? 0 : r < .75 ? 1 : 2;
    return r < .24 ? 0 : r < .65 ? 1 : 2;
  }

  function applyShipDepthSizing(ship) {
    const zScale = [0.82, 1.00, 1.17][ship.zLayer];
    const zSpeed = [0.84, 1.00, 1.14][ship.zLayer];
    ship.scale = ship.baseScale * zScale;
    ship.speed = ship.baseSpeed * zSpeed;
  }

  function createShip(i) {
    const lane = SHIP_LANES[i % SHIP_LANES.length];
    const types = ["dart","barge","needle","skiff"];
    const ship = {
      lane,
      type: choose(types),
      x: range(lane.x0, lane.x1),
      baseSpeed: range(7, 16) * lane.depth,
      baseScale: range(.62, 1.05) * lane.depth + .24,
      zLayer: randomShipDepth(lane),
      phase: range(0, TAU),
      drift: range(-7, 7),
      lightPhase: range(0, TAU),
      navOffset: 0,
    };
    applyShipDepthSizing(ship);
    return ship;
  }

  function recycleShip(ship, enteringFromRight) {
    ship.zLayer = randomShipDepth(ship.lane);
    ship.type = choose(["dart","barge","needle","skiff"]);
    ship.baseSpeed = range(7,16) * ship.lane.depth;
    ship.baseScale = range(.62,1.05) * ship.lane.depth + .24;
    ship.drift = range(-7,7);
    ship.phase = range(0,TAU);
    ship.lightPhase = range(0,TAU);
    ship.navOffset = 0;
    applyShipDepthSizing(ship);
    ship.x = enteringFromRight ? ship.lane.x1 + 90 : ship.lane.x0 - 90;
  }



  function resetEntities() {
    seedState = 0x9e3779b9;
    lights.length = 0;
    ships.length = 0;
    hazePuffs.length = 0;
    navigationAnchors.length = 0;
    lanternEmitters = [];
    waterfallRegions = [];
    waterfallCellMask = null;
    foliageRegions = [];
    mugSteamSource = null;
    fallingPetals = [];
    fogFlows = [];
    fogSprite = null;
    sceneAnchorsReady = false;
    for (let i = 0; i < 100; i++) lights.push(createFallbackLight(i));
    for (let i = 0; i < 12; i++) ships.push(createShip(i));
  }
  resetEntities();

  function resize() {
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
  }

  window.addEventListener("resize", resize, { passive: true });
  resize();

  function coverTransform(imgW, imgH) {
    const scale = Math.max(cssW / imgW, cssH / imgH);
    return {
      scale,
      ox: (cssW - imgW * scale) * .5,
      oy: (cssH - imgH * scale) * .5,
    };
  }

  function beginArtSpace() {
    const t = coverTransform(sourceW, sourceH);
    ctx.save();
    ctx.translate(t.ox * dpr, t.oy * dpr);
    ctx.scale(t.scale * dpr, t.scale * dpr);
    return t;
  }

  function endArtSpace() { ctx.restore(); }

  function drawBackground() {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#080812";
    ctx.fillRect(0, 0, cssW, cssH);
    const t = coverTransform(sourceW, sourceH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(background, t.ox, t.oy, sourceW * t.scale, sourceH * t.scale);
    ctx.restore();
  }

  function intensity() { return Number(controls.intensity.value); }
  function speedScale() { return Number(controls.speed.value); }



  function buildFogSprite() {
    if (fogSprite) return fogSprite;
    fogSprite = document.createElement("canvas");
    fogSprite.width = 64;
    fogSprite.height = 64;
    const fc = fogSprite.getContext("2d");
    const g = fc.createRadialGradient(32, 32, 0, 32, 32, 28);
    g.addColorStop(0.00, "rgba(235,242,245,.85)");
    g.addColorStop(0.38, "rgba(220,232,236,.38)");
    g.addColorStop(1.00, "rgba(214,224,230,0)");
    fc.fillStyle = g;
    fc.fillRect(0, 0, 64, 64);
    return fogSprite;
  }

  function buildFlowPath(points, width, spawnCount=8, alpha=.06, speedMin=10, speedMax=24, depth=1) {
    const seg = [];
    let total = 0;
    for (let i=0; i<points.length-1; i++) {
      const a = points[i], b = points[i+1];
      const dx = b[0]-a[0], dy = b[1]-a[1];
      const len = Math.hypot(dx, dy);
      seg.push({a, b, dx, dy, len});
      total += len;
    }
    return {points, seg, total, width, spawnCount, alpha, speedMin, speedMax, depth};
  }

  function pointOnFlow(flow, dist) {
    if (!flow.seg.length) {
      const p = flow.points[0] || [0,0];
      return {x:p[0], y:p[1], tx:1, ty:0, nx:0, ny:1};
    }
    let d = dist;
    for (const s of flow.seg) {
      if (d <= s.len) {
        const u = s.len ? d / s.len : 0;
        const tx = s.len ? s.dx / s.len : 1;
        const ty = s.len ? s.dy / s.len : 0;
        return {
          x: s.a[0] + s.dx*u,
          y: s.a[1] + s.dy*u,
          tx, ty,
          nx: -ty, ny: tx
        };
      }
      d -= s.len;
    }
    const last = flow.seg[flow.seg.length-1];
    const tx = last.len ? last.dx / last.len : 1;
    const ty = last.len ? last.dy / last.len : 0;
    return {x:last.b[0], y:last.b[1], tx, ty, nx:-ty, ny:tx};
  }

  function respawnFogParticle(p, randomOffset=true) {
    if (!fogFlows.length) return;
    const flowIndex = Math.floor(rnd() * fogFlows.length) % fogFlows.length;
    const flow = fogFlows[flowIndex];
    p.flowIndex = flowIndex;
    p.dist = randomOffset ? range(0, Math.max(8, flow.total * .24)) : 0;
    p.speed = range(flow.speedMin, flow.speedMax);
    p.accel = range(2.0, 5.2);
    p.size = range(26, 58) + flow.width * .18;
    p.alpha = flow.alpha * range(.7, 1.25);
    p.lateral = range(-flow.width*.24, flow.width*.24);
    p.wobble = range(0.8, 2.1);
    p.phase = range(0, TAU);
  }

  function createFogParticle(i) {
    const p = {
      flowIndex: 0,
      dist: 0,
      speed: 0,
      accel: 0,
      size: 0,
      alpha: 0,
      lateral: 0,
      wobble: 0,
      phase: range(0, TAU)
    };
    respawnFogParticle(p, true);
    return p;
  }

  function buildFogFlows() {
    fogFlows = [];

    // Build a set of art-specific downhill guides.
    // depth=1 -> far valley fog (hidden by mid/near geometry)
    // depth=2 -> mid-depth fog (hidden mainly by near foreground)

    const falls = waterfallRegions.slice().sort((a,b)=>(a.x-b.x));

    const upperFalls = [];
    const lowerFalls = [];
    for (const w of falls) {
      const cy = w.y + w.h * .5;
      if (cy < 520) upperFalls.push(w);
      else lowerFalls.push(w);
    }

    // --- Main upper-left waterfall spill into the central valley (far depth) ---
    const upperMain = upperFalls.length ? upperFalls[0] : null;
    if (upperMain) {
      const cx = upperMain.x + upperMain.w * .50;
      const y0 = upperMain.y + upperMain.h * .62;

      fogFlows.push(buildFlowPath([
        [cx,            y0],
        [cx + 10,       y0 + 34],
        [cx + 52,       y0 + 78],
        [cx + 110,      y0 + 128],
        [cx + 178,      y0 + 188]
      ], 22, 8, .050, 8, 15, 1));

      fogFlows.push(buildFlowPath([
        [cx + 4,        y0 + 16],
        [cx + 34,       y0 + 46],
        [cx + 88,       y0 + 92],
        [cx + 148,      y0 + 146]
      ], 16, 5, .036, 8, 14, 1));
    } else {
      fogFlows.push(buildFlowPath([
        [1028, 452], [1040, 487], [1086, 530], [1142, 581], [1208, 642]
      ], 22, 8, .050, 8, 15, 1));
      fogFlows.push(buildFlowPath([
        [1036, 470], [1066, 500], [1116, 544], [1176, 598]
      ], 16, 5, .036, 8, 14, 1));
    }

    // --- Lower central waterfall / basin (far to mid depth) ---
    const lowerMain = lowerFalls.length ? lowerFalls[0] : null;
    if (lowerMain) {
      const cx = lowerMain.x + lowerMain.w * .50;
      const y0 = lowerMain.y + lowerMain.h * .56;

      fogFlows.push(buildFlowPath([
        [cx,            y0],
        [cx + 10,       y0 + 40],
        [cx + 24,       y0 + 88],
        [cx + 46,       y0 + 138]
      ], 18, 6, .040, 8, 14, 1));

      fogFlows.push(buildFlowPath([
        [cx + 22,       y0 + 18],
        [cx + 68,       y0 + 54],
        [cx + 122,      y0 + 98],
        [cx + 186,      y0 + 146]
      ], 20, 6, .032, 8, 13, 1));
    } else {
      fogFlows.push(buildFlowPath([
        [1112, 585], [1122, 626], [1138, 673], [1160, 724]
      ], 18, 6, .040, 8, 14, 1));
      fogFlows.push(buildFlowPath([
        [1134, 603], [1180, 640], [1234, 683], [1296, 731]
      ], 20, 6, .032, 8, 13, 1));
    }

    // --- Left hillside / terrace slope (requested extra source) ---
    // Starts from the left-side descending terrain and drifts into the valley.
    fogFlows.push(buildFlowPath([
      [520, 430], [590, 482], [672, 540], [758, 606], [850, 676]
    ], 18, 6, .030, 7, 13, 2));

    // Smaller companion trail hugging the same left descent.
    fogFlows.push(buildFlowPath([
      [602, 470], [664, 514], [736, 568], [814, 628]
    ], 14, 4, .024, 7, 12, 2));

    // --- Right-side upper terrace / canyon inlet (requested extra source) ---
    // Comes off the mid-right structures and slopes down-left toward the basin.
    fogFlows.push(buildFlowPath([
      [1238, 498], [1188, 540], [1132, 586], [1070, 638]
    ], 17, 5, .028, 7, 12, 2));

    // --- Far-right ledge / right canyon shoulder (requested extra source) ---
    fogFlows.push(buildFlowPath([
      [1360, 546], [1326, 594], [1278, 640], [1216, 690]
    ], 16, 5, .028, 7, 12, 2));

    // --- Existing right-side mid-valley drift, kept low inside the canyon ---
    fogFlows.push(buildFlowPath([
      [1246, 560], [1296, 592], [1352, 628], [1412, 668]
    ], 18, 5, .028, 7, 12, 2));

    // Small upper-mid drift inside the mountain silhouette.
    fogFlows.push(buildFlowPath([
      [1106, 505], [1150, 540], [1204, 580], [1266, 626]
    ], 14, 4, .024, 7, 11, 1));

    hazePuffs.length = 0;
    let totalSpawn = 0;
    for (const f of fogFlows) totalSpawn += f.spawnCount;
    totalSpawn = clamp(totalSpawn, 16, 34);

    for (let i=0; i<totalSpawn; i++) hazePuffs.push(createFogParticle(i));
  }


  // ---------- Scene-aware pixel analysis ----------

  function growMaskWithinBounds(baseMask, width, height, passes=1, bounds=null) {
    let mask = baseMask.slice();
    for (let pass=0; pass<passes; pass++) {
      const next = mask.slice();
      for (let y=1; y<height-1; y++) {
        for (let x=1; x<width-1; x++) {
          if (mask[y*width+x]) continue;
          if (bounds) {
            if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) continue;
          }
          let n=0;
          for (let oy=-1; oy<=1; oy++) {
            for (let ox=-1; ox<=1; ox++) {
              if (!ox && !oy) continue;
              n += mask[(y+oy)*width + (x+ox)];
            }
          }
          if (n >= 4) next[y*width+x] = 1;
        }
      }
      mask = next;
    }
    return mask;
  }

  function buildMaskCanvasFromBinary(mask, width, height) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const cx = c.getContext("2d");
    const img = cx.createImageData(width, height);
    const d = img.data;
    for (let i=0; i<mask.length; i++) {
      if (!mask[i]) continue;
      const p=i*4;
      d[p]=255; d[p+1]=255; d[p+2]=255; d[p+3]=255;
    }
    cx.putImageData(img,0,0);
    return c;
  }


  function analyzeFoliageAndFlowers(sw, sh, scale, data, lum, rr, gg, bb) {
    const regions = [];
    const candidateZones = [
      // top hanging flowers / vines
      {x0:0, y0:0, x1:Math.round(sw*.42), y1:Math.round(sh*.30)},
      // left flowers near family
      {x0:0, y0:Math.round(sh*.34), x1:Math.round(sw*.18), y1:Math.round(sh*.76)},
      // lower center-right planter
      {x0:Math.round(sw*.54), y0:Math.round(sh*.65), x1:Math.round(sw*.78), y1:Math.round(sh*.90)},
      // lower right planters
      {x0:Math.round(sw*.75), y0:Math.round(sh*.58), x1:sw-1, y1:sh-1}
    ];

    for (const zone of candidateZones) {
      const mask = new Uint8Array(sw*sh);
      for (let y=zone.y0; y<=zone.y1; y++) {
        for (let x=zone.x0; x<=zone.x1; x++) {
          const i=y*sw+x;
          const r=rr[i], g=gg[i], b=bb[i], L=lum[i];

          const greenLeaf =
            g > 45 && g > r*1.05 && g > b*.88 &&
            L > 18 && L < 170;

          const pinkFlower =
            r > 88 && r > g*1.18 && r > b*.95 &&
            L > 38 && L < 178;

          if (greenLeaf || pinkFlower) mask[i]=1;
        }
      }

      const grown = growMaskWithinBounds(mask, sw, sh, 1, zone);
      const visited = new Uint8Array(sw*sh);
      const q = new Int32Array(sw*sh);

      for (let sy=zone.y0; sy<=zone.y1; sy++) {
        for (let sx=zone.x0; sx<=zone.x1; sx++) {
          const start = sy*sw+sx;
          if (!grown[start] || visited[start]) continue;
          let head=0, tail=0;
          q[tail++]=start;
          visited[start]=1;
          let minX=sx, maxX=sx, minY=sy, maxY=sy, count=0;
          const pixels=[];

          while (head<tail) {
            const idx=q[head++];
            const y=(idx/sw)|0;
            const x=idx-y*sw;
            pixels.push(idx);
            count++;
            if (x<minX) minX=x;
            if (x>maxX) maxX=x;
            if (y<minY) minY=y;
            if (y>maxY) maxY=y;

            for (let oy=-1; oy<=1; oy++) {
              for (let ox=-1; ox<=1; ox++) {
                if (!ox && !oy) continue;
                const nx=x+ox, ny=y+oy;
                if (nx<zone.x0||nx>zone.x1||ny<zone.y0||ny>zone.y1) continue;
                const ni=ny*sw+nx;
                if (!grown[ni] || visited[ni]) continue;
                visited[ni]=1;
                q[tail++]=ni;
              }
            }
          }

          const rw=maxX-minX+1, rh=maxY-minY+1;
          if (count < 45 || rw < 10 || rh < 10) continue;

          // classify region center for sway amplitude
          const cx=(minX+maxX)*.5 / scale;
          const cy=(minY+maxY)*.5 / scale;

          const maskLocal = new Uint8Array(rw*rh);
          let petalCandidates = [];
          for (const idx of pixels) {
            const y=(idx/sw)|0;
            const x=idx-y*sw;
            const li=(y-minY)*rw + (x-minX);
            maskLocal[li]=1;

            const p = idx;
            const r=rr[p], g=gg[p], b=bb[p];
            const flower =
              r > 98 && r > g*1.2 && r > b*.95;
            const leaf =
              g > 50 && g > r*1.08 && g > b*.9;

            if (flower || leaf) {
              petalCandidates.push({
                x: x/scale,
                y: y/scale,
                type: flower ? "petal" : "leaf",
                color: flower ? [230,72,112] : [145,175,90]
              });
            }
          }

          const maskCanvas = buildMaskCanvasFromBinary(maskLocal, rw, rh);
          const sourceCanvas = document.createElement("canvas");
          sourceCanvas.width = rw;
          sourceCanvas.height = rh;
          const sctx = sourceCanvas.getContext("2d");
          sctx.imageSmoothingEnabled = false;
          sctx.drawImage(background,
            minX/scale, minY/scale, rw/scale, rh/scale,
            0, 0, rw/scale, rh/scale
          );

          const scratchCanvas = document.createElement("canvas");
          scratchCanvas.width = rw;
          scratchCanvas.height = rh;
          const scratchCtx = scratchCanvas.getContext("2d");
          scratchCtx.imageSmoothingEnabled = false;

          regions.push({
            x:minX/scale,
            y:minY/scale,
            w:rw/scale,
            h:rh/scale,
            cx, cy,
            phase: ((regions.length*1.11)%6.283),
            sway: cy < sourceH*.35 ? 1.25 : 0.8,
            maskCanvas,
            sourceCanvas,
            scratchCanvas,
            scratchCtx,
            petalCandidates
          });
        }
      }
    }
    regions.sort((a,b) => (b.w*b.h) - (a.w*a.h));
    return regions.slice(0, 18);
  }

  function analyzeMugSteam(sw, sh, scale, lum, rr, gg, bb) {
    // Search only the lower-left table zone where the mug can plausibly be.
    // The mug's defining feature is its long amber/orange horizontal rim
    // sitting above a dark body. We anchor steam to the center of that rim.
    const x0=Math.floor(sw*.17), x1=Math.floor(sw*.29);
    const y0=Math.floor(sh*.69), y1=Math.floor(sh*.82);

    let best=null;

    for (let y=y0; y<=y1; y++) {
      let runStart=-1;
      let runEnd=-1;

      for (let x=x0; x<=x1+1; x++) {
        let warm=false;

        if (x<=x1) {
          const i=y*sw+x;
          const r=rr[i], g=gg[i], b=bb[i], L=lum[i];

          warm =
            r>92 &&
            g>42 &&
            r>g*1.25 &&
            r>b*1.40 &&
            L>48 && L<185;
        }

        if (warm && runStart<0) {
          runStart=x;
          runEnd=x;
        } else if (warm && runStart>=0) {
          // allow one-pixel gaps in the pixel-art rim
          runEnd=x;
        } else if (!warm && runStart>=0) {
          const len=runEnd-runStart+1;

          if (len>=13) {
            const cx=(runStart+runEnd)*.5;

            // Score for dark mug body immediately below the horizontal line.
            let darkBelow=0, totalBelow=0;
            for (let yy=y+2; yy<=Math.min(y+16,sh-1); yy++) {
              for (let xx=Math.max(x0,runStart); xx<=Math.min(x1,runEnd); xx++) {
                totalBelow++;
                if (lum[yy*sw+xx] < 82) darkBelow++;
              }
            }

            const darkness = totalBelow ? darkBelow/totalBelow : 0;
            const nativeLen=len/scale;

            // The actual mug rim in this artwork is around 40–60 native px.
            // Long table edges score lower.
            const lengthFit = 1-Math.min(1,Math.abs(nativeLen-48)/55);
            const score = len * (0.35+darkness*.65) * (0.45+lengthFit*.55);

            if (!best || score>best.score) {
              best={cx,y,score,len,darkness};
            }
          }

          runStart=-1;
          runEnd=-1;
        }
      }
    }

    if (best) {
      return {
        x:best.cx/scale,
        // Start slightly above the rim center, not in the mug body.
        y:(best.y/scale)-8,
        strength:1,
        detected:true
      };
    }

    // Exact fallback for the supplied 1672×941 artwork.
    return {
      x:395,
      y:712,
      strength:1,
      detected:false
    };
  }

  function maybeSpawnFallingPetal(t) {
    if (!controls.petals.checked || !foliageRegions.length) return;
    if (fallingPetals.length > 20) return;

    // About every 4-8 seconds on average.
    if (Math.random() > 0.03) return;

    const eligible = foliageRegions.filter(r => r.petalCandidates && r.petalCandidates.length);
    if (!eligible.length) return;
    const region = eligible[(Math.random()*eligible.length)|0];
    const src = region.petalCandidates[(Math.random()*region.petalCandidates.length)|0];

    fallingPetals.push({
      x: src.x,
      y: src.y,
      vx: (Math.random()-.5) * 7,
      vy: 2.2 + Math.random()*1.8,
      sway: .6 + Math.random()*1.3,
      rot: Math.random()*Math.PI*2,
      vr: (Math.random()-.5) * .08,
      size: src.type === "petal" ? 6 : 10,
      color: src.color,
      type: src.type,
      life: 0,
      maxLife: 4.2 + Math.random()*2.8
    });
  }


  // This runs once when an image is loaded. It finds bright local-contrast
  // pixel clusters in the artwork itself, classifies their color, and uses
  // those exact locations as animation anchors.
  function analyzeScene() {
    if (!background.complete || !background.naturalWidth) return;

    analysisStatus.textContent = "Analyzing…";
    sceneAnchorsReady = false;

    const maxScanW = 900;
    const scale = Math.min(1, maxScanW / background.naturalWidth);
    const sw = Math.max(64, Math.round(background.naturalWidth * scale));
    const sh = Math.max(64, Math.round(background.naturalHeight * scale));

    const off = document.createElement("canvas");
    off.width = sw;
    off.height = sh;
    const octx = off.getContext("2d", { willReadFrequently: true });
    octx.imageSmoothingEnabled = false;
    octx.drawImage(background, 0, 0, sw, sh);

    let data;
    try {
      data = octx.getImageData(0, 0, sw, sh).data;
    } catch (err) {
      analysisStatus.textContent = "fallback";
      return;
    }

    // Analyze in chunky cells to match the pixel-art character and avoid
    // treating anti-aliased single pixels as independent lights.
    const cell = 3;
    const gw = Math.floor(sw / cell);
    const gh = Math.floor(sh / cell);
    const lum = new Float32Array(gw * gh);
    const rr = new Uint8Array(gw * gh);
    const gg = new Uint8Array(gw * gh);
    const bb = new Uint8Array(gw * gh);

    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let bestL = -1, br = 0, bg = 0, b = 0;
        for (let yy = 0; yy < cell; yy++) {
          for (let xx = 0; xx < cell; xx++) {
            const px = gx * cell + xx;
            const py = gy * cell + yy;
            const p = (py * sw + px) * 4;
            const r = data[p], g = data[p+1], bl = data[p+2];
            const L = 0.2126*r + 0.7152*g + 0.0722*bl;
            if (L > bestL) { bestL = L; br = r; bg = g; b = bl; }
          }
        }
        const i = gy * gw + gx;
        lum[i] = bestL;
        rr[i] = br; gg[i] = bg; bb[i] = b;
      }
    }

    // Integral image for fast local-average brightness. Bright pixels surrounded
    // by darker pixels are much more likely to be actual emissive lights.
    const iw = gw + 1;
    const integral = new Float64Array((gw + 1) * (gh + 1));
    for (let y = 0; y < gh; y++) {
      let row = 0;
      for (let x = 0; x < gw; x++) {
        row += lum[y*gw+x];
        integral[(y+1)*iw + (x+1)] = integral[y*iw + (x+1)] + row;
      }
    }
    function localAverage(x, y, rad=3) {
      const x0 = Math.max(0, x-rad), y0 = Math.max(0, y-rad);
      const x1 = Math.min(gw-1, x+rad), y1 = Math.min(gh-1, y+rad);
      const A = integral[y0*iw+x0];
      const B = integral[y0*iw+(x1+1)];
      const C = integral[(y1+1)*iw+x0];
      const D = integral[(y1+1)*iw+(x1+1)];
      return (D-B-C+A) / ((x1-x0+1)*(y1-y0+1));
    }

    foliageRegions = analyzeFoliageAndFlowers(sw, sh, scale, data, lum, rr, gg, bb);
    mugSteamSource = analyzeMugSteam(sw, sh, scale, lum, rr, gg, bb);

    // ---------- Waterfall detection ----------
    // Water is detected separately from city lights. Instead of looking for
    // isolated bright pixels, we look for *continuous vertical cyan texture*.
    // That distinction is important: windows/beacons are tiny local peaks;
    // waterfalls are many neighboring blue/cyan cells extending downward.
    const cyanBase = new Uint8Array(gw * gh);
    const cyanStrength = new Float32Array(gw * gh);

    for (let y = 1; y < gh-1; y++) {
      for (let x = 1; x < gw-1; x++) {
        const i = y*gw+x;
        const r = rr[i], g = gg[i], b = bb[i], L = lum[i];
        const nativeX = (x*cell + cell*.5) / scale;
        const nativeY = (y*cell + cell*.5) / scale;

        // Waterfalls in this scene live below the skyline and toward the
        // center/right valley. Keeping this as a broad scene prior prevents
        // blue decoration on the foreground family from becoming "water".
        if (nativeX < sourceW*.40 || nativeY < sourceH*.30 || nativeY > sourceH*.88) continue;

        const coolDominance = ((g+b)*.5) - r;
        const cyanBalance = 1 - Math.min(1, Math.abs(g-b)/115);

        // Deliberately accepts medium-bright cyan texture, not merely highly
        // luminous pixels. Water is textured and often dimmer than neon.
        if (
          L > 58 &&
          g > 66 && b > 70 &&
          coolDominance > 10 &&
          cyanBalance > .18
        ) {
          cyanBase[i] = 1;
          cyanStrength[i] =
            Math.max(0, coolDominance) * .65 +
            Math.max(0, L-55) * .25 +
            cyanBalance * 18;
        }
      }
    }

    // Favor vertical continuity. A cell becomes part of the flow field when
    // it has other cyan cells above/below it. Isolated cyan windows therefore
    // usually disappear before connected-component analysis.
    const flowMask = new Uint8Array(gw * gh);
    for (let y = 2; y < gh-2; y++) {
      for (let x = 1; x < gw-1; x++) {
        let verticalHits = 0;
        let nearbyHits = 0;
        for (let yy=y-2; yy<=y+2; yy++) {
          for (let xx=x-1; xx<=x+1; xx++) {
            if (!cyanBase[yy*gw+xx]) continue;
            nearbyHits++;
            if (Math.abs(xx-x) <= 1 && Math.abs(yy-y) >= 1) verticalHits++;
          }
        }
        if (
          cyanBase[y*gw+x] &&
          verticalHits >= 2 &&
          nearbyHits >= 3
        ) flowMask[y*gw+x] = 1;
      }
    }

    // Bridge very small vertical gaps in a cascade, but do not horizontally
    // dilate the field; horizontal dilation would merge nearby building LEDs.
    for (let y = 2; y < gh-2; y++) {
      for (let x = 1; x < gw-1; x++) {
        const i = y*gw+x;
        if (flowMask[i]) continue;
        if (
          cyanBase[i] &&
          (flowMask[(y-1)*gw+x] || flowMask[(y-2)*gw+x]) &&
          (flowMask[(y+1)*gw+x] || flowMask[(y+2)*gw+x])
        ) flowMask[i] = 1;
      }
    }

    // Connected components on the vertically coherent cyan field.
    const visitedFlow = new Uint8Array(gw * gh);
    const queue = new Int32Array(gw * gh);
    const flowComponents = [];

    for (let sy=1; sy<gh-1; sy++) {
      for (let sx=1; sx<gw-1; sx++) {
        const start = sy*gw+sx;
        if (!flowMask[start] || visitedFlow[start]) continue;

        let head=0, tail=0;
        queue[tail++] = start;
        visitedFlow[start] = 1;

        let minX=sx, maxX=sx, minY=sy, maxY=sy;
        let strengthSum=0;
        const baseCells = [];

        while (head < tail) {
          const idx = queue[head++];
          const y = Math.floor(idx/gw);
          const x = idx-y*gw;

          minX=Math.min(minX,x); maxX=Math.max(maxX,x);
          minY=Math.min(minY,y); maxY=Math.max(maxY,y);

          if (cyanBase[idx]) {
            baseCells.push(idx);
            strengthSum += cyanStrength[idx];
          }

          for (let oy=-1; oy<=1; oy++) {
            for (let ox=-1; ox<=1; ox++) {
              if (!ox && !oy) continue;
              const nx=x+ox, ny=y+oy;
              if (nx<1 || nx>=gw-1 || ny<1 || ny>=gh-1) continue;
              const ni=ny*gw+nx;
              if (!flowMask[ni] || visitedFlow[ni]) continue;
              visitedFlow[ni]=1;
              queue[tail++]=ni;
            }
          }
        }

        if (!baseCells.length) continue;

        const nativeX = (minX*cell)/scale;
        const nativeY = (minY*cell)/scale;
        const nativeW = ((maxX-minX+1)*cell)/scale;
        const nativeH = ((maxY-minY+1)*cell)/scale;
        const aspect = nativeH / Math.max(1,nativeW);
        const gridArea = Math.max(1,(maxX-minX+1)*(maxY-minY+1));
        const density = baseCells.length / gridArea;

        // STRICT waterfall geometry.
        // We deliberately prefer missing a tiny waterfall over animating a
        // building window or neon rail as water.
        //
        // In this painting the real cascade is a broad cyan sheet. Windows,
        // vertical signage, elevator strips and cyan architectural trim are
        // either too narrow, too short, too sparse, or too perfectly linear.
        if (nativeH < 70) continue;
        if (nativeW < 40) continue;
        if (baseCells.length < 80) continue;
        if (aspect < .70 || aspect > 3.15) continue;
        if (density < .10 || density > .72) continue;

        // Require meaningful coverage across both dimensions, not a handful
        // of bright vertical rails spread across a large bounding box.
        const colCounts = new Map();
        const rowCounts = new Map();
        for (const idx of baseCells) {
          const cy = Math.floor(idx/gw);
          const cx = idx-cy*gw;
          colCounts.set(cx,(colCounts.get(cx)||0)+1);
          rowCounts.set(cy,(rowCounts.get(cy)||0)+1);
        }
        const gridW = maxX-minX+1;
        const gridH = maxY-minY+1;
        let usefulCols = 0, usefulRows = 0;
        for (const n of colCounts.values()) if (n >= Math.max(3,gridH*.12)) usefulCols++;
        for (const n of rowCounts.values()) if (n >= Math.max(3,gridW*.12)) usefulRows++;

        const colCoverage = usefulCols / gridW;
        const rowCoverage = usefulRows / gridH;

        if (colCoverage < .38) continue;
        if (rowCoverage < .55) continue;

        // A real pixel-art waterfall in this scene contains repeated
        // HORIZONTAL cyan ridges / lips. Vertical neon strips do not.
        // Measure rows that contain a reasonably wide cyan span, allowing
        // small gaps caused by dark vertical streaks in the painted water.
        let horizontalBandRows = 0;
        let strongestBand = 0;

        for (let yy=minY; yy<=maxY; yy++) {
          const xs = [];
          for (let xx=minX; xx<=maxX; xx++) {
            const ii = yy*gw+xx;
            if (cyanBase[ii]) xs.push(xx);
          }
          if (xs.length < 3) continue;

          let bestSpan = 0;
          let runStart = xs[0], prev = xs[0];
          for (let k=1; k<=xs.length; k++) {
            const xx = xs[k];
            if (k < xs.length && xx-prev <= 2) {
              prev = xx;
              continue;
            }
            bestSpan = Math.max(bestSpan, prev-runStart+1);
            if (k < xs.length) runStart = prev = xx;
          }

          const frac = bestSpan / Math.max(1,gridW);
          strongestBand = Math.max(strongestBand,frac);
          if (frac >= .24) horizontalBandRows++;
        }

        // This is the main defense against fake waterfalls on buildings:
        // require several broad horizontal cyan ridges.
        if (horizontalBandRows < Math.max(3,Math.floor(gridH*.055))) continue;
        if (strongestBand < .32) continue;

        const score =
          nativeH * (0.75 + Math.min(1.6,aspect)*.48) *
          Math.log(1+baseCells.length) *
          (0.78 + Math.min(.55,density));

        flowComponents.push({
          minX,maxX,minY,maxY,
          x:nativeX,y:nativeY,w:nativeW,h:nativeH,
          aspect,density,score,strengthSum,baseCells
        });
      }
    }

    flowComponents.sort((a,b)=>b.score-a.score);

    // Keep only the strongest broad-sheet cascades. This is intentionally
    // conservative; "no animation" is better than a fake waterfall.
    const selectedFalls = [];
    for (const c of flowComponents) {
      if (selectedFalls.length >= 2) break;

      if (c.w > c.h*1.40) continue;

      let overlapsTooMuch = false;
      for (const q of selectedFalls) {
        const ix = Math.max(0, Math.min(c.x+c.w,q.x+q.w)-Math.max(c.x,q.x));
        const iy = Math.max(0, Math.min(c.y+c.h,q.y+q.h)-Math.max(c.y,q.y));
        const overlap = ix*iy;
        const smaller = Math.min(c.w*c.h,q.w*q.h);
        if (smaller > 0 && overlap/smaller > .58) { overlapsTooMuch=true; break; }
      }
      if (!overlapsTooMuch) selectedFalls.push(c);
    }

    // Mark only the cyan cells belonging to accepted waterfall components.
    // The city-light detector consults this exact mask and refuses to turn
    // those cyan water pixels into blinking windows.
    waterfallCellMask = new Uint8Array(gw*gh);

    waterfallRegions = selectedFalls.map((c, regionIndex) => {
      for (const idx of c.baseCells) waterfallCellMask[idx] = 1;

      const regionX = Math.max(0,Math.floor(c.x));
      const regionY = Math.max(0,Math.floor(c.y));
      const regionW = Math.min(sourceW-regionX,Math.max(1,Math.ceil(c.w)));
      const regionH = Math.min(sourceH-regionY,Math.max(1,Math.ceil(c.h)));

      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = regionW;
      sourceCanvas.height = regionH;
      const sourceCtx = sourceCanvas.getContext("2d",{willReadFrequently:true});
      sourceCtx.imageSmoothingEnabled = false;
      sourceCtx.drawImage(
        background,
        regionX,regionY,regionW,regionH,
        0,0,regionW,regionH
      );

      const src = sourceCtx.getImageData(0,0,regionW,regionH);
      const sd = src.data;

      // Exact destination-water mask. No dilation: a moved highlight may only
      // land on a pixel that is already water-colored in the original image.
      // This automatically protects dark/orange foreground bridges.
      const waterMaskCanvas = document.createElement("canvas");
      waterMaskCanvas.width = regionW;
      waterMaskCanvas.height = regionH;
      const waterMaskCtx = waterMaskCanvas.getContext("2d");
      const waterMaskImage = waterMaskCtx.createImageData(regionW,regionH);
      const wm = waterMaskImage.data;

      const strong = new Uint8Array(regionW*regionH);
      const soft = new Uint8Array(regionW*regionH);

      for (let y=0; y<regionH; y++) {
        for (let x=0; x<regionW; x++) {
          const p=(y*regionW+x)*4;
          const r=sd[p], g=sd[p+1], b=sd[p+2];
          const L=.2126*r+.7152*g+.0722*b;
          const cool=((g+b)*.5)-r;
          const balanced=1-Math.min(1,Math.abs(g-b)/120);

          const isSoft =
            L>48 && g>58 && b>64 &&
            cool>7 && balanced>.10;

          const isStrong =
            L>88 && g>98 && b>105 &&
            cool>18 && balanced>.14;

          if (isSoft) {
            soft[y*regionW+x]=1;
            wm[p]=255; wm[p+1]=255; wm[p+2]=255; wm[p+3]=255;
          }
          if (isStrong) strong[y*regionW+x]=1;
        }
      }
      waterMaskCtx.putImageData(waterMaskImage,0,0);

      // Foreground-depth protection. Even if the bridge contains a few cyan
      // reflections, near architecture wins and cannot be painted over.
      const occlusionCanvas=document.createElement("canvas");
      occlusionCanvas.width=regionW;
      occlusionCanvas.height=regionH;
      const occlusionCtx=occlusionCanvas.getContext("2d");
      const oi=occlusionCtx.createImageData(regionW,regionH);
      const od=oi.data;
      for (let y=0;y<regionH;y++) {
        for (let x=0;x<regionW;x++) {
          const depth=sceneDepthAt(regionX+x,regionY+y);
          if (depth>=3) {
            const p=(y*regionW+x)*4;
            od[p]=od[p+1]=od[p+2]=255; od[p+3]=255;
          }
        }
      }
      occlusionCtx.putImageData(oi,0,0);

      // Extract HORIZONTAL cyan line fragments from the original waterfall.
      // Small dark gaps are bridged when grouping, matching the pixel-art
      // horizontal ridges visible in the source.
      const lineSegments=[];
      const minRun=Math.max(4,Math.round(regionW*.055));

      for (let y=1;y<regionH-1;y++) {
        let x=0;
        while (x<regionW) {
          while (x<regionW && !strong[y*regionW+x]) x++;
          if (x>=regionW) break;

          const x0=x;
          let last=x;
          let gap=0;
          x++;

          while (x<regionW) {
            if (strong[y*regionW+x]) {
              last=x; gap=0;
            } else {
              gap++;
              if (gap>2) break;
            }
            x++;
          }

          const x1=last;
          const len=x1-x0+1;

          if (len>=minRun) {
            // Horizontal-ness check: require more strong cyan support across
            // this row than immediately above/below at the same span.
            let here=0, above=0, below=0;
            for (let xx=x0;xx<=x1;xx++) {
              here += strong[y*regionW+xx];
              above += strong[(y-1)*regionW+xx];
              below += strong[(y+1)*regionW+xx];
            }
            const occupancy=here/len;

            if (occupancy>=.34 && len>=minRun) {
              lineSegments.push({
                x0,x1,y,
                h: (above>here*.82 && below>here*.82) ? 1 : 2,
                strength:occupancy,
                phase:((y*.173+x0*.071+regionIndex*.317)%1)
              });
            }
          }
        }
      }

      // Merge near-identical adjacent rows into one ridge so thick waterfall
      // lips move as a coherent little strip instead of duplicated scan lines.
      lineSegments.sort((a,b)=>a.y-b.y || a.x0-b.x0);
      const merged=[];
      for (const s of lineSegments) {
        const prev=merged[merged.length-1];
        if (
          prev &&
          s.y-prev.y<=2 &&
          Math.abs(s.x0-prev.x0)<=3 &&
          Math.abs(s.x1-prev.x1)<=3
        ) {
          prev.h=Math.max(prev.h,(s.y+s.h)-prev.y);
          prev.strength=Math.max(prev.strength,s.strength);
        } else {
          merged.push({...s});
        }
      }

      const scratchCanvas=document.createElement("canvas");
      scratchCanvas.width=regionW;
      scratchCanvas.height=regionH;
      const scratchCtx=scratchCanvas.getContext("2d");
      scratchCtx.imageSmoothingEnabled=false;

      return {
        x:regionX,y:regionY,w:regionW,h:regionH,
        phase:(regionIndex*.271)%1,
        score:c.score,
        detected:true,
        sourceCanvas,
        waterMaskCanvas,
        occlusionCanvas,
        scratchCanvas,
        scratchCtx,
        lines:merged
      };
    });

    const candidates = [];
    const warmGrid = new Float32Array(gw * gh);

    for (let y = 2; y < gh-2; y++) {
      for (let x = 2; x < gw-2; x++) {
        const i = y*gw+x;
        const r = rr[i], g = gg[i], b = bb[i];
        const L = lum[i];
        const local = localAverage(x,y,3);
        const contrast = L - local;
        const maxc = Math.max(r,g,b), minc = Math.min(r,g,b);
        const chroma = maxc - minc;

        // Require a bright locally-emissive pixel.
        if (L < 92 || contrast < 22 || chroma < 22) continue;

        // Genuine lamps/windows normally sit against darker structural pixels.
        // Count local dark support so isolated stars / sky sparkles do not
        // become animated city lights.
        let darkSupport=0;
        let structuralSupport=0;
        for (let oy=-2;oy<=2;oy++) {
          for (let ox=-2;ox<=2;ox++) {
            if (!ox && !oy) continue;
            const ni=(y+oy)*gw+(x+ox);
            if (lum[ni] < L-20) darkSupport++;
          }
        }

        let kind = null;
        if (r > 145 && g > 62 && r > b * 1.16 && g > b * .85) kind = "warm";
        if (g > 105 && b > 105 && Math.max(g,b) > r * 1.16) kind = "cyan";
        if (r > 135 && r > g * 1.28 && r > b * 1.08) kind = "red";
        if (!kind) continue;

        const nativeX = (x*cell + cell*.5) / scale;
        const nativeY = (y*cell + cell*.5) / scale;

        // A light should be on, or immediately adjacent to, something solid.
        // This single check removes most false sky detections while preserving
        // beacons that protrude one or two pixels beyond a tower silhouette.
        structuralSupport=maxSceneDepthAround(nativeX,nativeY,7);

        if (!structuralSupport && darkSupport<5) continue;
        if (nativeY < sourceH*.28 && structuralSupport===0) continue;

        const score =
          contrast * 1.45 +
          chroma * .25 +
          Math.max(0,L-120)*.35 +
          Math.min(10,darkSupport)*1.3 +
          structuralSupport*4.0;

        candidates.push({
          x, y, nativeX, nativeY, r, g, b, L, contrast, score, kind,
          inWaterfall: !!(waterfallCellMask && waterfallCellMask[i]),
          darkSupport,
          structuralSupport
        });
        if (kind === "warm") warmGrid[i] = score;
      }
    }

    // Non-maximum suppression gives us one anchor per visible light cluster.
    candidates.sort((a,b) => b.score-a.score);
    const chosen = [];
    const minDistNative = 10;
    for (const c of candidates) {
      if (chosen.length >= 150) break;

      // Waterfall pixels are continuous reflective/flowing material, not
      // discrete lamps. They are animated by drawWaterfalls() instead.
      if (c.kind === "cyan" && c.inWaterfall) continue;
      // City/emissive anchors focus on the actual skyline; left foreground
      // emitters are handled separately as lanterns.
      if (c.nativeX < sourceW * .35 && c.nativeY > sourceH * .25) continue;

      // Isolated bright pixels in open atmosphere are usually stars, not city
      // infrastructure. Keep only unusually well-supported exceptions.
      if (!c.structuralSupport && c.darkSupport<7) continue;
      let near = false;
      for (const q of chosen) {
        const dx = c.nativeX-q.nativeX, dy = c.nativeY-q.nativeY;
        if (dx*dx+dy*dy < minDistNative*minDistNative) { near = true; break; }
      }
      if (!near) chosen.push(c);
    }

    lights.length = 0;
    navigationAnchors.length = 0;
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      lights.push({
        x: c.nativeX, y: c.nativeY,
        size: c.score > 110 ? 2 : 1,
        kind: c.kind,
        color: `rgb(${c.r},${c.g},${c.b})`,
        rate: .20 + ((i*37)%53)/100,
        phase: ((i*1.618)%1)*TAU,
        duty: 3.2 + ((i*17)%39)/10,
        base: .025 + Math.min(.11, c.score/1500),
        score: c.score
      });
      if (c.nativeX > sourceW*.42 && c.score > 62) {
        navigationAnchors.push({x:c.nativeX, y:c.nativeY, score:c.score});
      }
    }

    // Find dense warm-emission peaks. Large warm clusters receive large haze;
    // small windows receive only their normal city-light pulse.
    const warmPeaks = [];
    const rad = 5;
    for (const c of candidates) {
      if (c.kind !== "warm" || c.nativeY < sourceH*.19) continue;
      let density = 0;
      for (let yy=Math.max(0,c.y-rad); yy<=Math.min(gh-1,c.y+rad); yy++) {
        for (let xx=Math.max(0,c.x-rad); xx<=Math.min(gw-1,c.x+rad); xx++) {
          const dx=xx-c.x, dy=yy-c.y;
          if (dx*dx+dy*dy <= rad*rad) density += warmGrid[yy*gw+xx];
        }
      }
      const emitterScore = density + c.score*3;
      if (emitterScore > 420) warmPeaks.push({...c, emitterScore});
    }
    warmPeaks.sort((a,b)=>b.emitterScore-a.emitterScore);

    lanternEmitters = [];
    for (const c of warmPeaks) {
      if (lanternEmitters.length >= 7) break;

      // Reject the sunset disk / broad sky emission.
      if (c.nativeY < sourceH*.34 && c.nativeX > sourceW*.42) continue;

      // Strong NMS: one atmospheric emitter per luminous object.
      let near = false;
      for (const q of lanternEmitters) {
        const dx=c.nativeX-q.x, dy=c.nativeY-q.y;
        if (dx*dx+dy*dy < 82*82) { near=true; break; }
      }
      if (near) continue;

      const strength = clamp(c.emitterScore / 4000, .45, 1.2);
      lanternEmitters.push({
        x:c.nativeX, y:c.nativeY,
        outer: clamp(62 + strength*46, 68, 125),
        mid: clamp(30 + strength*20, 32, 62),
        core: clamp(9 + strength*5, 10, 17),
        phase: ((lanternEmitters.length*2.11) % TAU),
        power: strength,
        detected: true
      });
    }

    // If automatic warm-emitter discovery does not find enough strong sources,
    // keep the known artwork lanterns as a safe fallback.
    if (lanternEmitters.length < 2) lanternEmitters = FALLBACK_LANTERNS.map(v=>({...v}));

    sceneAnchorsReady = true;
    buildFogFlows();

    analysisStatus.textContent =
      `${lights.length} lights · ${waterfallRegions.length} fall · ${foliageRegions.length} foliage · ${hazePuffs.length} fog`;
  }

  function drawDetectedAnchors() {
    const showAll = controls.showAnchors.checked;
    const showFog = controls.showFogDetection.checked || showAll;
    const showMug = controls.showMugDetection.checked || showAll;

    if (!showAll && !showFog && !showMug) return;

    ctx.save();
    ctx.lineWidth = 1;

    if (showAll) {
      for (const l of lights) {
        ctx.strokeStyle = l.kind === "cyan" ? "rgba(90,240,245,.6)" :
                          l.kind === "warm" ? "rgba(255,180,70,.55)" :
                                              "rgba(255,75,80,.55)";
        ctx.strokeRect(Math.round(l.x)-2, Math.round(l.y)-2, 5, 5);
      }
      for (const e of lanternEmitters) {
        ctx.strokeStyle = "rgba(255,220,120,.85)";
        ctx.beginPath();
        ctx.arc(e.x,e.y,Math.max(8,e.core+5),0,TAU);
        ctx.stroke();
      }

      for (const w of waterfallRegions) {
        ctx.strokeStyle = "rgba(105,235,255,.92)";
        ctx.setLineDash([5,4]);
        ctx.strokeRect(Math.round(w.x),Math.round(w.y),Math.round(w.w),Math.round(w.h));
        ctx.setLineDash([]);

        ctx.save();
        ctx.globalAlpha=.75;
        ctx.fillStyle="#a8fbff";
        for (const line of (w.lines||[])) {
          ctx.fillRect(
            Math.round(w.x+line.x0),
            Math.round(w.y+line.y),
            Math.max(1,line.x1-line.x0+1),
            1
          );
        }
        ctx.restore();
      }
    }

    if (showFog) {
      ctx.save();
      for (const flow of fogFlows) {
        const pts = flow.points || [];
        if (!pts.length) continue;

        ctx.strokeStyle = flow.depth === 2
          ? "rgba(255,205,150,.92)"
          : "rgba(185,240,245,.95)";
        ctx.fillStyle = ctx.strokeStyle;

        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], 4, 0, TAU);
        ctx.stroke();

        const tail = pointOnFlow(flow, Math.max(4, flow.total * .72));
        const ax = tail.x, ay = tail.y;
        const bx = ax - tail.tx * 10 + tail.nx * 4;
        const by = ay - tail.ty * 10 + tail.ny * 4;
        const cx = ax - tail.tx * 10 - tail.nx * 4;
        const cy = ay - tail.ty * 10 - tail.ny * 4;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.lineTo(cx, cy);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }

    if (showMug && mugSteamSource) {
      ctx.save();
      ctx.strokeStyle="rgba(235,245,245,.95)";
      ctx.lineWidth=1;
      ctx.beginPath();
      ctx.arc(mugSteamSource.x,mugSteamSource.y,6,0,TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mugSteamSource.x-9,mugSteamSource.y);
      ctx.lineTo(mugSteamSource.x+9,mugSteamSource.y);
      ctx.moveTo(mugSteamSource.x,mugSteamSource.y-9);
      ctx.lineTo(mugSteamSource.x,mugSteamSource.y+9);
      ctx.stroke();

      // Show an approximate vapor footprint so the width/anchor can be debugged.
      const vw = Number(controls.vaporWidth.value);
      ctx.setLineDash([4,3]);
      ctx.strokeStyle = "rgba(220,235,240,.55)";
      ctx.strokeRect(
        mugSteamSource.x - 22*vw,
        mugSteamSource.y - 70,
        44*vw,
        78
      );
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.restore();
  }

  // ---------- Pixel-art ship sprites ----------
  // Ships are rasterized to a tiny scratch canvas first. We can then compare
  // each sprite pixel against the scene's depth map before drawing it.
  const SHIP_SCRATCH_W = 72;
  const SHIP_SCRATCH_H = 40;
  const SHIP_CX = SHIP_SCRATCH_W >> 1;
  const SHIP_CY = SHIP_SCRATCH_H >> 1;
  const shipScratch = document.createElement("canvas");
  shipScratch.width = SHIP_SCRATCH_W;
  shipScratch.height = SHIP_SCRATCH_H;
  const shipCtx = shipScratch.getContext("2d", { willReadFrequently:true });
  shipCtx.imageSmoothingEnabled = false;

  function spxRect(x,y,w,h,color,alpha=1) {
    shipCtx.globalAlpha = alpha;
    shipCtx.fillStyle = color;
    shipCtx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));
  }

  function drawShip(ship, t, I) {
    const lane = ship.lane;
    const bob = Math.sin(t * .55 + ship.phase) * .8;
    const y = lane.y + ship.drift + bob;
    const s = ship.scale;

    shipCtx.save();
    shipCtx.setTransform(1,0,0,1,0,0);
    shipCtx.clearRect(0,0,SHIP_SCRATCH_W,SHIP_SCRATCH_H);
    shipCtx.translate(SHIP_CX,SHIP_CY);
    if (lane.dir > 0) shipCtx.scale(-1,1);
    shipCtx.scale(s,s);

    const engine = .15 + .1 * Math.sin(t * 2.3 + ship.phase);
    spxRect(9,1,8,2,"#ff503a",engine*I);

    if (ship.type === "dart") {
      spxRect(-11,-2,19,5,"#141725",.90);
      spxRect(-5,-5,8,3,"#262c3a",.92);
      spxRect(-8,3,14,2,"#0d111d",.95);
      spxRect(-3,-3,4,1,"#78ecf0",.55*I);
      spxRect(6,-1,2,1,"#ff473d",(.2+.8*Math.max(0,Math.sin(t*3+ship.lightPhase)))*I);
    } else if (ship.type === "barge") {
      spxRect(-14,-3,24,6,"#111521",.92);
      spxRect(-9,-6,13,3,"#282a38",.90);
      spxRect(-11,3,17,2,"#0b0f19",.95);
      spxRect(-6,-4,3,1,"#65e7eb",.45*I);
      spxRect(1,-4,4,1,"#65e7eb",.35*I);
      spxRect(8,-1,2,2,"#ff3e3e",(.15+.75*Math.max(0,Math.sin(t*2.2+ship.lightPhase)))*I);
    } else if (ship.type === "needle") {
      spxRect(-13,-1,23,3,"#151827",.92);
      spxRect(-4,-4,6,3,"#303342",.90);
      spxRect(-7,2,13,1,"#0d1019",.96);
      spxRect(-2,-3,2,1,"#6aeaf1",.5*I);
      spxRect(8,0,1,1,"#ff5547",(.2+.75*Math.max(0,Math.sin(t*2.8+ship.lightPhase)))*I);
    } else {
      spxRect(-10,-3,17,6,"#161925",.92);
      spxRect(-6,-5,8,2,"#2d3140",.88);
      spxRect(-13,-1,5,2,"#0d1019",.95);
      spxRect(-2,-4,3,1,"#70e8ee",.45*I);
      spxRect(5,-1,2,1,"#ff473d",(.18+.8*Math.max(0,Math.sin(t*2.5+ship.lightPhase)))*I);
    }
    shipCtx.restore();
    shipCtx.globalAlpha = 1;

    // Occlude only the individual sprite pixels covered by a closer object.
    // This produces real edge-by-edge disappearance behind tower silhouettes.
    if (controls.depthOcclusion.checked && depthLevels) {
      const im = shipCtx.getImageData(0,0,SHIP_SCRATCH_W,SHIP_SCRATCH_H);
      const d = im.data;
      for (let py=0; py<SHIP_SCRATCH_H; py++) {
        for (let px=0; px<SHIP_SCRATCH_W; px++) {
          const ai = (py*SHIP_SCRATCH_W+px)*4+3;
          if (!d[ai]) continue;
          const gx = ship.x + (px-SHIP_CX);
          const gy = y + (py-SHIP_CY);
          if (sceneDepthAt(gx,gy) > ship.zLayer) d[ai] = 0;
        }
      }
      shipCtx.putImageData(im,0,0);
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      shipScratch,
      Math.round(ship.x-SHIP_CX),
      Math.round(y-SHIP_CY)
    );
    ctx.restore();
  }

  function updateAndDrawShips(dt, t, I) {
    const maxShips = Number(controls.shipCount.value);
    for (let i=0; i<Math.min(maxShips,ships.length); i++) {
      const ship = ships[i];
      ship.x += ship.speed * ship.lane.dir * dt * speedScale() * (.55 + I*.65);

      // Navigation still reacts gently to dense beacon clusters, but much less
      // than before: ships are now allowed to cross tower silhouettes because
      // depth occlusion makes that crossing visually meaningful.
      const baseY = ship.lane.y + ship.drift;
      let desired = 0;
      if (sceneAnchorsReady) {
        for (const a of navigationAnchors) {
          const dx = Math.abs(a.x-ship.x);
          const dy = Math.abs(a.y-baseY);
          if (dx<48 && dy<27) {
            const influence=(1-dx/48)*(1-dy/27);
            desired += (baseY<=a.y ? -1 : 1) * influence * 4.2;
          }
        }
      }
      desired = clamp(desired,-6,6);
      ship.navOffset += (desired-ship.navOffset) * Math.min(1,dt*1.65);

      const margin = 95;
      if (ship.lane.dir<0 && ship.x<ship.lane.x0-margin) {
        recycleShip(ship,true);
      } else if (ship.lane.dir>0 && ship.x>ship.lane.x1+margin) {
        recycleShip(ship,false);
      }

      const originalDrift=ship.drift;
      ship.drift=originalDrift+ship.navOffset;
      drawShip(ship,t,I);
      ship.drift=originalDrift;
    }
  }

  function drawLights(t, I) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";

    for (const l of lights) {
      const baseColor = l.color || (
        l.kind === "cyan" ? "#77f2ef" :
        l.kind === "warm" ? "#ffc066" :
        "#ff4c46"
      );

      let pulse = 0;
      let dx = 0;
      let dy = 0;

      if (l.kind === "warm") {
        // Candle / flame behavior:
        // several slow + fast sine components create an irregular but smooth
        // variation without noisy frame-to-frame randomness.
        const slow = 0.5 + 0.5 * Math.sin(t * (0.72 + l.rate*.32) + l.phase);
        const mid  = 0.5 + 0.5 * Math.sin(t * (2.15 + l.rate*.55) + l.phase*1.71);
        const fast = 0.5 + 0.5 * Math.sin(t * (5.4  + l.rate*.85) + l.phase*2.37);

        // Small brightness troughs make amber sources read as flame rather
        // than an LED. Never fully turns off.
        pulse = clamp(
          0.52 + slow*0.23 + mid*0.17 + fast*0.08,
          0.46, 1.0
        );

        // Very small apparent flame movement. Stronger/brighter sources may
        // shift almost one artwork pixel; tiny windows move less.
        const move = (l.score || 70) > 105 ? 0.95 : 0.42;
        dx = Math.sin(t*3.1 + l.phase*1.9) * move
           + Math.sin(t*6.8 + l.phase*.7) * move*.24;
        dy = -Math.abs(Math.sin(t*2.65 + l.phase*1.3)) * move*.72
           + Math.sin(t*5.1 + l.phase*2.2) * move*.18;
      } else {
        // Red/cyan city lights behave more like electronics / beacons:
        // mostly stable, with occasional crisp pulses.
        const slowWave = Math.max(0, Math.sin(t * l.rate + l.phase));
        const beacon = Math.pow(slowWave, l.duty);
        const shimmer = 0.5 + 0.5*Math.sin(t*(1.4 + l.rate*.8) + l.phase*1.4);
        pulse = clamp(0.28 + beacon*0.62 + shimmer*0.10, 0.2, 1);
      }

      const a = (l.base + pulse * (l.kind === "warm" ? .30 : .32)) * I;
      const s = l.size || 1;
      const x = l.x + dx;
      const y = l.y + dy;

      // Main emissive source.
      ctx.globalAlpha = a;
      ctx.fillStyle = baseColor;
      ctx.fillRect(
        Math.round(x) - Math.floor(s/2),
        Math.round(y) - Math.floor(s/2),
        s, s
      );

      if (l.kind === "warm") {
        // Tiny inner hot point + asymmetric flame-shaped bloom.
        // This makes an amber cluster feel like a flame moving inside glass.
        const hotAlpha = a * (0.38 + pulse*.32);
        ctx.globalAlpha = hotAlpha;
        ctx.fillStyle = "#fff0b8";
        ctx.fillRect(Math.round(x), Math.round(y-0.7), 1, 1);

        const glowR = (l.score || 0) > 100 ? 5.2 : 3.3;
        const gx = x + dx*.45;
        const gy = y - 0.8 + dy*.55;

        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, glowR);
        g.addColorStop(0,   `rgba(255,236,176,${a*.60})`);
        g.addColorStop(.22, `rgba(255,184,82,${a*.42})`);
        g.addColorStop(.58, `rgba(255,102,34,${a*.18})`);
        g.addColorStop(1,   "rgba(255,74,18,0)");
        ctx.fillStyle = g;
        ctx.fillRect(gx-glowR, gy-glowR, glowR*2, glowR*2);

        // A faint upward tongue only on stronger warm emitters.
        if ((l.score || 0) > 96) {
          const tongueH = 3.5 + pulse*2.2;
          const tongueW = 1.8 + pulse*.8;
          const tg = ctx.createLinearGradient(x, y-tongueH, x, y+1);
          tg.addColorStop(0, "rgba(255,118,35,0)");
          tg.addColorStop(.45, `rgba(255,142,42,${a*.14})`);
          tg.addColorStop(1, `rgba(255,206,92,${a*.26})`);
          ctx.fillStyle = tg;
          ctx.fillRect(x-tongueW/2, y-tongueH, tongueW, tongueH+1);
        }
      } else {
        // Tiny beacon bloom for bright red/cyan sources.
        if ((l.score || 0) > 95 && pulse > .55) {
          const r = 3.5;
          const col = l.kind === "cyan" ? "110,245,245" : "255,75,75";
          const g = ctx.createRadialGradient(x,y,0,x,y,r);
          g.addColorStop(0, `rgba(${col},${a*.58})`);
          g.addColorStop(1, `rgba(${col},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(x-r,y-r,r*2,r*2);
        }
      }
    }

    ctx.restore();
  }


  function updateAndDrawHaze(dt, t, I) {
    if (!hazePuffs.length || !fogFlows.length) return;

    const fogStrength = Number(controls.fogStrength.value);
    const fogFlowSpeed = Number(controls.fogFlowSpeed.value);
    if (fogStrength <= 0.001) return;

    const sprite = buildFogSprite();
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.imageSmoothingEnabled = true;

    for (const p of hazePuffs) {
      const flow = fogFlows[p.flowIndex];
      if (!flow) continue;

      p.speed += p.accel * dt * .24 * fogFlowSpeed;
      p.dist += p.speed * dt * speedScale() * fogFlowSpeed;

      if (p.dist > flow.total + p.size*.35) {
        respawnFogParticle(p, false);
      }

      const pos = pointOnFlow(flow, p.dist);
      const wobble = Math.sin(simTime*.55 + p.phase + p.dist*.018) * p.wobble;
      const lateral = p.lateral + wobble * 2.4;

      const x = pos.x + pos.nx * lateral + pos.tx * 2.5 * wobble;
      const y = pos.y + pos.ny * lateral * .28;

      const scene = sceneDepthAt(x, y);

      // Flow depth handling:
      // depth 1 = far fog, hidden by scene depth 2/3
      // depth 2 = mid fog, hidden mainly by near foreground depth 3
      if (scene > flow.depth) continue;

      const fadeIn = clamp(p.dist / 26, 0, 1);
      const fadeOut = clamp((flow.total - p.dist) / 56, 0, 1);

      let depthFade = 1;
      if (scene === flow.depth && flow.depth > 0) depthFade = 0.82;
      if (scene === 0 && flow.depth === 2) depthFade = 0.90;

      const alpha = p.alpha * fadeIn * fadeOut * (.8 + I*.55) * depthFade * fogStrength;

      const w = p.size * (1.26 + Math.abs(pos.tx)*.1);
      const h = p.size * (.58 + Math.abs(pos.ty)*.18);

      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, x - w*.5, y - h*.5, w, h);

      ctx.globalAlpha = alpha * .52;
      ctx.drawImage(
        sprite,
        x - pos.tx*12 - w*.38,
        y - pos.ty*12 - h*.38,
        w*.76, h*.76
      );
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }



  function updateAndDrawFallingPetals(dt, t, I) {
    maybeSpawnFallingPetal(t);

    for (let i=fallingPetals.length-1; i>=0; i--) {
      const p = fallingPetals[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        fallingPetals.splice(i,1);
        continue;
      }

      p.x += p.vx * dt + Math.sin(t*1.8 + p.rot) * p.sway * dt;
      p.y += p.vy * dt * 24;
      p.rot += p.vr;

      // cull when it goes off the visible terrace/city region
      if (p.y > sourceH + 20 || p.x < -10 || p.x > sourceW + 10) {
        fallingPetals.splice(i,1);
        continue;
      }

      const fade = Math.max(0, 1 - p.life / p.maxLife);

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = (.45 + I*.25) * fade;
      ctx.fillStyle = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
      if (p.type === "leaf") {
        ctx.fillRect(-1.5, -2.5, 7, 5);
      } else {
        ctx.fillRect(-1.5, -1.5, 7, 3);
      }
      ctx.restore();
    }
  }

  function drawMugVapor(t, I) {
    if (!mugSteamSource) return;

    const vaporStrength = Number(controls.vaporStrength.value);
    const vaporWidth = Number(controls.vaporWidth.value);
    if (vaporStrength <= 0.001) return;

    const sx = mugSteamSource.x;
    const sy = mugSteamSource.y;

    ctx.save();
    ctx.globalCompositeOperation = "screen";

    const glowR = 24 * vaporWidth;
    const baseGlow = ctx.createRadialGradient(sx, sy+1, 0, sx, sy+1, glowR);
    baseGlow.addColorStop(0, `rgba(240,242,238,${(0.090 + I*0.050) * vaporStrength})`);
    baseGlow.addColorStop(0.42, `rgba(226,232,234,${(0.040 + I*0.022) * vaporStrength})`);
    baseGlow.addColorStop(1, "rgba(218,226,231,0)");
    ctx.fillStyle = baseGlow;
    ctx.fillRect(sx-28*vaporWidth, sy-14, 56*vaporWidth, 34);

    function drawSteamPlume(seed, offsetX, height, alphaMul) {
      const sway1 = Math.sin(t*0.74 + seed*2.1);
      const sway2 = Math.sin(t*1.17 + seed*1.23);

      const x0 = sx + offsetX * vaporWidth;
      const y0 = sy + 2;

      const cx1 = x0 + sway1 * 4.6 * vaporWidth;
      const cy1 = y0 - height * 0.26;

      const cx2 = x0 + sway2 * 7.0 * vaporWidth + offsetX * 0.35 * vaporWidth;
      const cy2 = y0 - height * 0.66;

      const x3 = x0 + Math.sin(t*0.55 + seed*1.35) * 9.0 * vaporWidth;
      const y3 = y0 - height;

      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const inv = 1-u;

        const px =
          inv*inv*inv*x0 +
          3*inv*inv*u*cx1 +
          3*inv*u*u*cx2 +
          u*u*u*x3;

        const py =
          inv*inv*inv*y0 +
          3*inv*inv*u*cy1 +
          3*inv*u*u*cy2 +
          u*u*u*y3;

        const fade = Math.pow(1-u, 0.88);
        const radius = (4.8 + u*10.5) * (0.82 + vaporWidth*0.45);
        const outerAlpha = (0.060 + I*0.055) * fade * alphaMul * vaporStrength;
        const innerAlpha = outerAlpha * 0.52;

        const outer = ctx.createRadialGradient(px, py, 0, px, py, radius);
        outer.addColorStop(0, `rgba(233,239,241,${outerAlpha})`);
        outer.addColorStop(0.58, `rgba(222,230,233,${outerAlpha*0.52})`);
        outer.addColorStop(1, "rgba(217,226,231,0)");
        ctx.fillStyle = outer;
        ctx.fillRect(px-radius, py-radius, radius*2, radius*2);

        const inner = ctx.createRadialGradient(px, py, 0, px, py, radius*0.48);
        inner.addColorStop(0, `rgba(246,248,246,${innerAlpha})`);
        inner.addColorStop(1, "rgba(239,243,242,0)");
        ctx.fillStyle = inner;
        ctx.fillRect(px-radius*.6, py-radius*.6, radius*1.2, radius*1.2);
      }
    }

    drawSteamPlume(0.2, -8.0, 56, 0.92);
    drawSteamPlume(1.0, -2.5, 68, 1.05);
    drawSteamPlume(1.8,  3.5, 66, 1.00);
    drawSteamPlume(2.6,  8.5, 54, 0.85);

    const capX = sx + Math.sin(t*0.38)*2.6 * vaporWidth;
    const capY = sy - 60;
    const capR = 22 * (0.82 + vaporWidth*0.4);
    const cap = ctx.createRadialGradient(capX, capY, 0, capX, capY, capR);
    cap.addColorStop(0, `rgba(228,235,237,${(0.040 + I*0.026) * vaporStrength})`);
    cap.addColorStop(0.6, `rgba(219,228,232,${(0.020 + I*0.012) * vaporStrength})`);
    cap.addColorStop(1, "rgba(214,224,230,0)");
    ctx.fillStyle = cap;
    ctx.fillRect(capX-26*vaporWidth, capY-22, 52*vaporWidth, 44);

    ctx.restore();
  }

  function drawWaterfalls(t, I) {
    if (!waterfallRegions.length) return;

    for (let ri=0;ri<waterfallRegions.length;ri++) {
      const w=waterfallRegions[ri];
      const sc=w.scratchCtx;
      const cw=w.w, ch=w.h;

      sc.save();
      sc.setTransform(1,0,0,1,0,0);
      sc.clearRect(0,0,cw,ch);
      sc.imageSmoothingEnabled=false;
      sc.globalCompositeOperation="source-over";

      for (let i=0;i<w.lines.length;i++) {
        const line=w.lines[i];
        const width=line.x1-line.x0+1;

        const cycle=9 + (i%4)*2;
        const speed=(2.9 + (i%3)*.42) * speedScale();
        const off=(t*speed + line.phase*cycle) % cycle;
        const phase=off/cycle;
        const fade=phase<.76 ? 1 : Math.max(0,1-(phase-.76)/.24);

        const dy=Math.floor(off);
        const dx=Math.round(Math.sin(t*.78 + line.y*.081 + ri)*.55);

        sc.globalAlpha=(.42 + .54*line.strength) * I * fade;
        sc.drawImage(
          w.sourceCanvas,
          line.x0,line.y,width,line.h,
          line.x0+dx,line.y+dy,width,line.h
        );

        if (line.strength>.42) {
          sc.globalAlpha=.19*I*fade;
          sc.drawImage(
            w.sourceCanvas,
            line.x0,line.y,width,1,
            line.x0-dx,line.y+dy+2,width,1
          );
        }

        sc.globalAlpha=.11*I*fade;
        sc.fillStyle="#9ffaff";
        sc.fillRect(line.x0+dx, line.y+dy, width, 1);
      }

      sc.globalAlpha=1;
      sc.globalCompositeOperation="destination-in";
      sc.drawImage(w.waterMaskCanvas,0,0);

      sc.globalCompositeOperation="destination-out";
      sc.drawImage(w.occlusionCanvas,0,0);
      sc.restore();

      ctx.save();
      ctx.imageSmoothingEnabled=false;
      ctx.globalAlpha=1.0;
      ctx.drawImage(w.scratchCanvas,w.x,w.y);
      ctx.restore();

      const mistX=w.x+w.w*.5;
      const mistY=w.y+w.h;
      const mistR=clamp(w.w*.28,16,44);
      ctx.save();
      ctx.globalCompositeOperation="screen";
      const mist=ctx.createRadialGradient(mistX,mistY,0,mistX,mistY,mistR);
      mist.addColorStop(0,`rgba(120,226,233,${.022*I})`);
      mist.addColorStop(.55,`rgba(90,180,200,${.010*I})`);
      mist.addColorStop(1,"rgba(70,145,170,0)");
      ctx.fillStyle=mist;
      ctx.fillRect(mistX-mistR,mistY-mistR*.28,mistR*2,mistR*.56);
      ctx.restore();
    }
  }

  function drawLanterns(t, I) {
    const strength = Number(controls.lanternStrength.value);
    const radiusMul = Number(controls.lanternRadius.value);

    ctx.save();
    ctx.globalCompositeOperation = "screen";

    const emitters = lanternEmitters.length ? lanternEmitters : FALLBACK_LANTERNS;

    for (const l of emitters) {
      // Irregular fire intensity — no hard blinking.
      const slow = 0.5 + 0.5 * Math.sin(t * 0.68 + l.phase);
      const mid  = 0.5 + 0.5 * Math.sin(t * 2.05 + l.phase*1.53);
      const fast = 0.5 + 0.5 * Math.sin(t * 5.7  + l.phase*2.31);
      const pulse = clamp(0.72 + slow*.13 + mid*.10 + fast*.05, .68, 1.0);

      // The apparent flame source moves around inside the lantern by only a
      // few pixels. The broad haze follows less, which makes the flame feel
      // like it's shifting inside a fixed glass enclosure.
      const shiftX = Math.sin(t*2.4 + l.phase*1.8) * 2.2
                   + Math.sin(t*6.2 + l.phase*.9) * .55;
      const shiftY = -Math.abs(Math.sin(t*2.1 + l.phase*1.25)) * 1.9
                   + Math.sin(t*5.0 + l.phase*2.0) * .45;

      const outer = l.outer * radiusMul;
      const midR  = l.mid * radiusMul;
      const core  = l.core * radiusMul;

      // Broad haze follows only ~20% of flame motion.
      const hx = l.x + shiftX*.20;
      const hy = l.y + shiftY*.20;
      const hazeAlpha = 0.105 * strength * I * l.power * pulse;

      const haze = ctx.createRadialGradient(hx, hy, 0, hx, hy, outer);
      haze.addColorStop(0.00, `rgba(255,193,102,${hazeAlpha*1.20})`);
      haze.addColorStop(0.18, `rgba(255,142,60,${hazeAlpha*.95})`);
      haze.addColorStop(0.45, `rgba(255,94,35,${hazeAlpha*.48})`);
      haze.addColorStop(0.72, `rgba(255,72,22,${hazeAlpha*.18})`);
      haze.addColorStop(1.00, "rgba(255,55,12,0)");
      ctx.fillStyle = haze;
      ctx.fillRect(hx-outer, hy-outer, outer*2, outer*2);

      // Mid bloom follows ~55% of flame motion.
      const mx = l.x + shiftX*.55;
      const my = l.y + shiftY*.55;
      const midAlpha = 0.15 * strength * I * l.power * pulse;

      const bloom = ctx.createRadialGradient(mx, my, 0, mx, my, midR);
      bloom.addColorStop(0.00, `rgba(255,238,178,${midAlpha*1.25})`);
      bloom.addColorStop(0.22, `rgba(255,194,105,${midAlpha})`);
      bloom.addColorStop(0.58, `rgba(255,117,44,${midAlpha*.48})`);
      bloom.addColorStop(1.00, "rgba(255,82,22,0)");
      ctx.fillStyle = bloom;
      ctx.fillRect(mx-midR, my-midR, midR*2, midR*2);

      // The hot core follows the flame fully.
      const cx = l.x + shiftX;
      const cy = l.y + shiftY;
      const coreAlpha = 0.21 * strength * I * l.power * pulse;

      const hot = ctx.createRadialGradient(cx, cy, 0, cx, cy, core);
      hot.addColorStop(0.00, `rgba(255,255,226,${coreAlpha})`);
      hot.addColorStop(0.28, `rgba(255,229,158,${coreAlpha*.88})`);
      hot.addColorStop(0.68, `rgba(255,158,67,${coreAlpha*.40})`);
      hot.addColorStop(1.00, "rgba(255,108,36,0)");
      ctx.fillStyle = hot;
      ctx.fillRect(cx-core, cy-core, core*2, core*2);

      // Subtle flame tongue rising from the moving core.
      const flameH = core * (1.35 + pulse*.55);
      const flameW = core * .58;
      const flame = ctx.createLinearGradient(cx, cy-flameH, cx, cy+2);
      flame.addColorStop(0.00, "rgba(255,100,28,0)");
      flame.addColorStop(0.34, `rgba(255,123,34,${coreAlpha*.16})`);
      flame.addColorStop(0.72, `rgba(255,180,68,${coreAlpha*.38})`);
      flame.addColorStop(1.00, `rgba(255,240,172,${coreAlpha*.50})`);
      ctx.fillStyle = flame;
      ctx.fillRect(cx-flameW/2, cy-flameH, flameW, flameH+2);

      // Fixed-ish surrounding dust haze.
      const plumeW = outer * .42;
      const plumeH = outer * .90;
      const plumeAlpha = .030 * strength * I * l.power * pulse;
      const plume = ctx.createLinearGradient(hx, hy-plumeH, hx, hy+8);
      plume.addColorStop(0.0, "rgba(255,110,45,0)");
      plume.addColorStop(.55, `rgba(255,126,52,${plumeAlpha*.35})`);
      plume.addColorStop(1.0, `rgba(255,174,82,${plumeAlpha})`);
      ctx.fillStyle = plume;
      ctx.fillRect(hx-plumeW*.5, hy-plumeH, plumeW, plumeH);
    }

    ctx.restore();
  }

  function render(dt) {
    if (!background.complete || !background.naturalWidth) return;

    drawBackground();
    beginArtSpace();

    const I = intensity();
    const t = simTime;

    // Back-to-front order.
    if (controls.waterfalls.checked) drawWaterfalls(t, I);
    if (controls.haze.checked) updateAndDrawHaze(dt, t, I);
    if (controls.lights.checked) drawLights(t, I);
    if (controls.ships.checked) updateAndDrawShips(dt, t, I);
    if (controls.petals.checked) updateAndDrawFallingPetals(dt, t, I);
    if (controls.lanterns.checked) drawLanterns(t, I);
    if (controls.mugVapor.checked) drawMugVapor(t, I);
    drawDetectedAnchors();
    drawDepthDebug();

    endArtSpace();
  }

  function tick(now) {
    frameHandle = requestAnimationFrame(tick);
    if (document.hidden || paused) return;

    const elapsed = now - lastFrame;
    if (elapsed < FRAME_MS) return;
    lastFrame = now - (elapsed % FRAME_MS);

    const dt = clamp(elapsed / 1000, 0, .08);
    simTime += dt;
    render(dt);

    measuredFrames++;
    if (now - measuredAt > 1000) {
      readouts.fps.textContent = measuredFrames + " fps";
      measuredFrames = 0;
      measuredAt = now;
    }
  }

  background.addEventListener("load", () => {
    sourceW = background.naturalWidth;
    sourceH = background.naturalHeight;
    resetEntities();
    buildDepthMap();
    // Let the browser paint once, then perform the one-time pixel analysis.
    requestAnimationFrame(() => {
      analyzeScene();
      render(0);
    });
  });

  // ---------- Persistent settings ----------
  const SETTINGS_STORAGE_KEY = "cyberpunk-live-wallpaper-settings-v12.4";

  const PERSISTED_SETTING_NAMES = [
    "intensity",
    "speed",
    "shipCount",
    "lanternStrength",
    "lanternRadius",
    "fogStrength",
    "fogFlowSpeed",
    "vaporStrength",
    "vaporWidth",
    "lights",
    "ships",
    "haze",
    "waterfalls",
    "lanterns",
    "petals",
    "mugVapor",
    "depthOcclusion",
    "showDepth",
    "showAnchors",
    "showFogDetection",
    "showMugDetection"
  ];

  const FACTORY_DEFAULTS = {
    intensity: "1",
    speed: "1.5",
    shipCount: "12",
    lanternStrength: ".85",
    lanternRadius: "1.3",
    fogStrength: "2",
    fogFlowSpeed: ".35",
    vaporStrength: ".75",
    vaporWidth: "2.04",

    lights: true,
    ships: true,
    haze: true,
    waterfalls: true,
    lanterns: true,
    petals: true,
    mugVapor: true,
    depthOcclusion: true,

    showDepth: false,
    showAnchors: false,
    showFogDetection: false,
    showMugDetection: false
  };

  function applySettingValue(name, value) {
    const el = controls[name];
    if (!el || value === undefined || value === null) return;

    if (el.type === "checkbox") {
      el.checked = Boolean(value);
    } else {
      el.value = String(value);
    }
  }

  function applyFactoryDefaults() {
    for (const [name, value] of Object.entries(FACTORY_DEFAULTS)) {
      applySettingValue(name, value);
    }
  }

  function readSettingsFromControls() {
    const result = {};
    for (const name of PERSISTED_SETTING_NAMES) {
      const el = controls[name];
      if (!el) continue;
      result[name] = el.type === "checkbox" ? el.checked : el.value;
    }
    return result;
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(readSettingsFromControls())
      );
    } catch (_) {
      // Browsers can disable localStorage in some privacy/file contexts.
      // The app still works; it simply falls back to factory defaults.
    }
  }

  function loadSettings() {
    applyFactoryDefaults();

    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;

      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;

      for (const name of PERSISTED_SETTING_NAMES) {
        if (Object.prototype.hasOwnProperty.call(saved, name)) {
          applySettingValue(name, saved[name]);
        }
      }
    } catch (_) {
      // Ignore corrupted/unavailable storage and keep factory defaults.
    }
  }

  function resetSavedSettings() {
    try {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
    } catch (_) {}
    applyFactoryDefaults();
    updateReadouts();
    saveSettings();
  }

  loadSettings();

  // ---------- UI ----------
  function updateReadouts() {
    readouts.intensity.textContent = Math.round(Number(controls.intensity.value) * 100) + "%";
    readouts.speed.textContent = Math.round(Number(controls.speed.value) * 100) + "%";
    readouts.shipCount.textContent = controls.shipCount.value;
    readouts.lanternStrength.textContent = Math.round(Number(controls.lanternStrength.value) * 100) + "%";
    readouts.lanternRadius.textContent = Math.round(Number(controls.lanternRadius.value) * 100) + "%";
    readouts.fogStrength.textContent = Math.round(Number(controls.fogStrength.value) * 100) + "%";
    readouts.fogFlowSpeed.textContent = Math.round(Number(controls.fogFlowSpeed.value) * 100) + "%";
    readouts.vaporStrength.textContent = Math.round(Number(controls.vaporStrength.value) * 100) + "%";
    readouts.vaporWidth.textContent = Math.round(Number(controls.vaporWidth.value) * 100) + "%";
  }

  ["input","change"].forEach(evt => {
    Object.values(controls).forEach(el => {
      el.addEventListener(evt, () => {
        updateReadouts();
        saveSettings();
      });
    });
  });
  updateReadouts();

  function setPreset(name) {
    if (name === "barely") {
      controls.intensity.value = .27;
      controls.speed.value = .48;
      controls.shipCount.value = 3;
      controls.lanternStrength.value = .62;
      controls.lanternRadius.value = .92;
      controls.fogStrength.value = .78;
      controls.fogFlowSpeed.value = .82;
      controls.vaporStrength.value = .84;
      controls.vaporWidth.value = .92;
    } else if (name === "calm") {
      controls.intensity.value = .45;
      controls.speed.value = .70;
      controls.shipCount.value = 5;
      controls.lanternStrength.value = .85;
      controls.lanternRadius.value = 1.00;
      controls.fogStrength.value = 1.00;
      controls.fogFlowSpeed.value = 1.00;
      controls.vaporStrength.value = 1.00;
      controls.vaporWidth.value = 1.00;
    } else {
      controls.intensity.value = .67;
      controls.speed.value = .92;
      controls.shipCount.value = 8;
      controls.lanternStrength.value = 1.12;
      controls.lanternRadius.value = 1.18;
      controls.fogStrength.value = 1.22;
      controls.fogFlowSpeed.value = 1.16;
      controls.vaporStrength.value = 1.18;
      controls.vaporWidth.value = 1.12;
    }
    updateReadouts();
    saveSettings();
  }

  document.querySelectorAll("[data-preset]").forEach(btn => {
    btn.addEventListener("click", () => setPreset(btn.dataset.preset));
  });

  const pauseButton = byId("pause");
  function togglePause() {
    paused = !paused;
    pauseButton.textContent = paused ? "Resume" : "Pause";
    if (!paused) lastFrame = performance.now();
  }
  pauseButton.addEventListener("click", togglePause);

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (_) {}
  }
  byId("fullscreen").addEventListener("click", toggleFullscreen);
  byId("resetSettings").addEventListener("click", resetSavedSettings);

  function setHudHidden(value) {
    hidden = Boolean(value);
    hud.classList.toggle("hidden", hidden);
    mini.classList.toggle("hidden", !hidden);
  }
  byId("hide").addEventListener("click", () => setHudHidden(true));
  mini.addEventListener("click", () => setHudHidden(false));

  byId("fileInput").addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      background.src = reader.result;
      setHudHidden(true);
    };
    reader.readAsDataURL(file);
  });

  document.addEventListener("keydown", e => {
    if (e.code === "Space") {
      e.preventDefault();
      togglePause();
    } else if (e.key.toLowerCase() === "h") {
      setHudHidden(!hidden);
    } else if (e.key.toLowerCase() === "f") {
      toggleFullscreen();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) lastFrame = performance.now();
  });

  frameHandle = requestAnimationFrame(tick);
})();

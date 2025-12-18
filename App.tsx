import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FilesetResolver, HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { AppMode, Particle } from './types';

// --- Constants ---
const PARTICLE_COUNT = 900; 
const DUST_COUNT = 4000; 
const TREE_HEIGHT = 55;
const TREE_BASE_RADIUS = 22;
const SCATTER_RADIUS = 70;
const LERP_SPEED = 0.025; 

// --- PALETTE ---
const COLOR_MATTE_GREEN = 0x2a6a3a;    
const COLOR_RICH_GOLD = 0xffbf00;      
const COLOR_ROSE_GOLD = 0xffcf99;      
const COLOR_DEEP_RED = 0xc2002b;       
const COLOR_WARM_LIGHT = 0xffeebb;     
const COLOR_BG = 0x050805;             

// --- Helper: Texture Generation ---
const createStripedTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128; 
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#aa0011'; 
    ctx.beginPath();
    for (let i = -128; i < 256; i += 32) {
       ctx.moveTo(i, 0); ctx.lineTo(i + 16, 0); ctx.lineTo(i + 144, 128); ctx.lineTo(i + 128, 128); ctx.lineTo(i, 0);
    }
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 3);
  return tex;
};

// --- Helper: Soft Glow Sprite for Particles (Bokeh) ---
const createBokehTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    // More intense core for cinematic sparkle
    grad.addColorStop(0, 'rgba(255, 240, 200, 1)'); 
    grad.addColorStop(0.2, 'rgba(255, 210, 120, 0.8)'); 
    grad.addColorStop(0.5, 'rgba(255, 180, 50, 0.2)'); 
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
};

// --- Helper: Geometries & Prefabs ---
const createStarGeometry = (radius = 1, thickness = 0.5) => {
  const shape = new THREE.Shape();
  const numPoints = 5;
  const innerRadius = radius * 0.45;
  for (let i = 0; i < numPoints * 2; i++) {
    const l = i % 2 === 0 ? radius : innerRadius;
    const a = (i / (numPoints * 2)) * Math.PI * 2 + Math.PI / 2; 
    const x = Math.cos(a) * l;
    const y = Math.sin(a) * l;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 1 });
  geom.center();
  return geom;
};

// IMPROVED 3D BELL
const createBell = (baseMat: THREE.Material) => {
  const g = new THREE.Group();
  
  // Clone material to ensure double-sided rendering for the bell specifically
  const mat = baseMat.clone();
  mat.side = THREE.DoubleSide;

  // 1. Hull (Body)
  const points = [];
  points.push(new THREE.Vector2(0.6, 0)); 
  points.push(new THREE.Vector2(0.5, 0.1));
  points.push(new THREE.Vector2(0.4, 0.3));
  points.push(new THREE.Vector2(0.35, 0.6));
  points.push(new THREE.Vector2(0.25, 0.9));
  points.push(new THREE.Vector2(0.15, 1.0)); 
  points.push(new THREE.Vector2(0.0, 1.0));  

  const hullGeo = new THREE.LatheGeometry(points, 32);
  hullGeo.translate(0, -0.5, 0); // Center geometry vertically
  const hull = new THREE.Mesh(hullGeo, mat);

  // 2. Clapper (Inner ball)
  const clapperGeo = new THREE.SphereGeometry(0.12, 16, 16);
  clapperGeo.translate(0, -0.4, 0); // Position near bottom
  const clapper = new THREE.Mesh(clapperGeo, mat);

  // 3. Ring (Top handle)
  const ringGeo = new THREE.TorusGeometry(0.08, 0.02, 8, 16);
  ringGeo.rotateX(Math.PI / 2);
  ringGeo.translate(0, 0.5, 0);
  const ring = new THREE.Mesh(ringGeo, mat);

  g.add(hull, clapper, ring);
  
  // Base scale boost to match previous geometry scale
  g.scale.setScalar(1.2); 
  
  return g;
};

const createApple = (redMat: THREE.Material) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16), redMat);
    const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.03, 0.35, 6), 
        new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 1.0 })
    );
    stem.position.y = 0.45;
    g.add(body, stem);
    return g;
};

// --- LIVELY SANTA HAT ---
const createSantaHat = (redMat: THREE.Material) => {
    const g = new THREE.Group();
    g.userData = { isHat: true }; // Tag for rotation logic
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0.1 });
    
    // 1. Brim (Fluffy Torus)
    const brim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.14, 8, 20), whiteMat);
    brim.rotation.x = Math.PI / 2;
    brim.scale.z = 0.9; 
    
    // 2. Base Section (Wide cylinder)
    const baseH = 0.25;
    const baseGeo = new THREE.CylinderGeometry(0.24, 0.34, baseH, 16);
    baseGeo.translate(0, baseH/2, 0); // pivot at bottom
    const base = new THREE.Mesh(baseGeo, redMat);
    
    // 3. Mid Section (Tapering)
    const midH = 0.25;
    const midGeo = new THREE.CylinderGeometry(0.13, 0.24, midH, 16);
    midGeo.translate(0, midH/2, 0);
    const mid = new THREE.Mesh(midGeo, redMat);
    mid.position.y = baseH * 0.9;
    
    // Random "Lively" Tilt - bends to the side
    const tiltZ = -0.2 - Math.random() * 0.35; 
    const tiltX = (Math.random() - 0.5) * 0.4;
    mid.rotation.set(tiltX, 0, tiltZ);

    // 4. Top Section (Tip)
    const topH = 0.35;
    const topGeo = new THREE.ConeGeometry(0.13, topH, 16); 
    topGeo.translate(0, topH/2, 0);
    const top = new THREE.Mesh(topGeo, redMat);
    top.position.y = midH * 0.9;
    
    // Extreme bend for the floppy tip
    top.rotation.set((Math.random()-0.5)*0.5, 0, -0.6 - Math.random() * 0.6);

    // 5. Pom Pom (Ball)
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 14), whiteMat);
    ball.position.y = topH; 
    
    top.add(ball);
    mid.add(top);
    base.add(mid);
    g.add(brim);
    g.add(base);
    
    g.position.y = -0.3; // Center visually
    g.scale.setScalar(1.2);

    return g;
};

const createBow = (redMat: THREE.Material) => {
    const geo = new THREE.TorusKnotGeometry(0.25, 0.08, 64, 8, 2, 3);
    return new THREE.Mesh(geo, redMat);
};

// --- GESTURE LOGIC TYPES ---
type GestureType = 'NONE' | 'FIST' | 'OPEN_ROTATE' | 'PINCH_ZOOM' | 'L_SHAPE_PHOTO';

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>(AppMode.LOADING);
  const [loadingText, setLoadingText] = useState("ILLUMINATING");
  const [debugInfo, setDebugInfo] = useState("");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [showCamera, setShowCamera] = useState(false);

  const mountRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const atmosphereRef = useRef<THREE.Points | null>(null);
  const modeRef = useRef<AppMode>(AppMode.LOADING);
  
  // Hand Logic Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rotationOffsetRef = useRef(0);
  const rotationSpeedRef = useRef(0.005); // Controls how fast it spins
  const isCountingDownRef = useRef(false);
  const photoModeDebounceRef = useRef(0);
  const gestureRef = useRef<GestureType>('NONE');

  useEffect(() => {
    if (!mountRef.current) return;

    // 1. Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLOR_BG); 
    scene.fog = new THREE.FogExp2(COLOR_BG, 0.012); 

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 70);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1; 
    mountRef.current.appendChild(renderer.domElement);

    // 2. Post Processing
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5, 0.4, 0.85
    );
    bloomPass.strength = 1.3; 
    bloomPass.radius = 0.6;   
    bloomPass.threshold = 0.15; 

    const composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);

    // 3. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.1); 
    scene.add(ambientLight);

    const mainLight = new THREE.PointLight(COLOR_RICH_GOLD, 1000, 200); 
    mainLight.position.set(20, 40, 20);
    scene.add(mainLight);

    const fillLight = new THREE.PointLight(COLOR_WARM_LIGHT, 600, 100);
    fillLight.position.set(-20, 10, -15);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xaaccff, 1.5); 
    rimLight.position.set(0, 10, -50);
    scene.add(rimLight);

    // 4. Materials
    const envMap = new THREE.CubeTextureLoader().load([
      'https://threejs.org/examples/textures/cube/Park2/posx.jpg',
      'https://threejs.org/examples/textures/cube/Park2/negx.jpg',
      'https://threejs.org/examples/textures/cube/Park2/posy.jpg',
      'https://threejs.org/examples/textures/cube/Park2/negy.jpg',
      'https://threejs.org/examples/textures/cube/Park2/posz.jpg',
      'https://threejs.org/examples/textures/cube/Park2/negz.jpg',
    ]);
    scene.environment = envMap;
    scene.environmentIntensity = 1.2; 

    const matteGreenMat = new THREE.MeshStandardMaterial({ 
      color: COLOR_MATTE_GREEN, 
      roughness: 0.9, 
      metalness: 0.0,
      emissive: 0x051105, 
      emissiveIntensity: 0.2, 
    });

    const richGoldMat = new THREE.MeshStandardMaterial({ 
      color: COLOR_RICH_GOLD, 
      emissive: COLOR_RICH_GOLD, 
      emissiveIntensity: 0.6, 
      metalness: 1.0, 
      roughness: 0.05, 
      envMapIntensity: 2.0 
    });

    const glowingGoldMat = new THREE.MeshStandardMaterial({
        color: COLOR_RICH_GOLD, 
        emissive: COLOR_RICH_GOLD,
        emissiveIntensity: 2.5, 
        metalness: 0.7,
        roughness: 0.1,
    });

    const roseGoldMat = new THREE.MeshStandardMaterial({ 
      color: COLOR_ROSE_GOLD, 
      emissive: 0xcf8866, 
      emissiveIntensity: 0.4, 
      metalness: 0.95, 
      roughness: 0.1, 
      envMapIntensity: 1.8
    });

    const glossyRedMat = new THREE.MeshPhysicalMaterial({ 
      color: COLOR_DEEP_RED, 
      emissive: 0x550000, 
      emissiveIntensity: 0.4, 
      metalness: 0.1, 
      roughness: 0.2,
      clearcoat: 1.0, 
      clearcoatRoughness: 0.05
    });

    const feltRedMat = new THREE.MeshStandardMaterial({
        color: COLOR_DEEP_RED,
        roughness: 0.9,
        metalness: 0.1,
    });

    const snowflakeMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xccffff,
        emissiveIntensity: 0.6,
        roughness: 0.2,
        metalness: 0.5
    });

    const warmLightMat = new THREE.MeshBasicMaterial({ color: COLOR_WARM_LIGHT }); 
    const caneMat = new THREE.MeshStandardMaterial({ 
      map: createStripedTexture(),
      roughness: 0.3,
      emissive: 0x111111
    });

    // 5. Shared Geometries
    const sphereGeo = new THREE.SphereGeometry(0.65, 32, 32); 
    const wreathPoints: THREE.Vector3[] = [];
    const wr = 0.5; 
    const wr_thick = 0.12; 
    const wr_winds = 15; 
    for (let j = 0; j <= 200; j++) {
       const t = (j / 200) * Math.PI * 2;
       const ang = t * wr_winds;
       const x = (wr + wr_thick * Math.cos(ang)) * Math.cos(t);
       const y = (wr + wr_thick * Math.cos(ang)) * Math.sin(t);
       const z = wr_thick * Math.sin(ang);
       wreathPoints.push(new THREE.Vector3(x, y, z));
    }
    const wreathCurve = new THREE.CatmullRomCurve3(wreathPoints, true);
    const wreathGeo = new THREE.TubeGeometry(wreathCurve, 120, 0.04, 8, true);
    const berryGeo = new THREE.SphereGeometry(0.06, 8, 8);
    const lightBulbGeo = new THREE.SphereGeometry(0.25, 16, 16); 
    const snowflakeGeo = new THREE.IcosahedronGeometry(0.35, 0); 
    const starOrnamentGeo = createStarGeometry(0.5, 0.25);
    
    // 6. Particle Factory
    const particles: Particle[] = [];
    const mainGroup = new THREE.Group();
    scene.add(mainGroup);

    const createGift = () => {
      const g = new THREE.Group();
      const w = 0.7 + Math.random() * 0.6;
      const h = 0.6 + Math.random() * 0.6;
      const d = 0.7 + Math.random() * 0.6;
      
      let mat = richGoldMat;
      const r = Math.random();
      if (r < 0.5) mat = roseGoldMat; 

      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      const ribbonMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.8, roughness: 0.2 });
      const r1 = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, h * 0.9, 0.1), ribbonMat);
      const r2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, h * 0.9, d + 0.05), ribbonMat);
      g.add(box, r1, r2);
      return g;
    };

    const createWreath = () => {
        const group = new THREE.Group();
        const ring = new THREE.Mesh(wreathGeo, matteGreenMat);
        group.add(ring);
        for(let k=0; k<7; k++){
             const b = new THREE.Mesh(berryGeo, glossyRedMat);
             const angle = (k / 7) * Math.PI * 2 + (Math.random() * 0.5);
             const rBase = wr; 
             const offsetR = (Math.random() - 0.5) * wr_thick * 1.5; 
             const zOffset = (Math.random() - 0.5) * wr_thick * 1.5;
             b.position.set(Math.cos(angle) * (rBase + offsetR), Math.sin(angle) * (rBase + offsetR), zOffset + 0.05);
             group.add(b);
        }
        return group;
    };

    const getTreePos = () => {
        const hNorm = Math.pow(Math.random(), 0.9); 
        const y = (hNorm * TREE_HEIGHT) - (TREE_HEIGHT / 2);
        const hFactor = (y + TREE_HEIGHT/2) / TREE_HEIGHT;
        const maxR = TREE_BASE_RADIUS * (1.0 - hFactor);
        const r = maxR * (0.2 + 0.8 * Math.sqrt(Math.random())); 
        const theta = Math.random() * Math.PI * 2;
        return new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
    };

    // Initialize Particles
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      let mesh: THREE.Object3D;
      let pType: Particle['type'];
      const rand = Math.random();

      // Distribution Logic
      if (rand < 0.15) {
        pType = 'BRANCH'; 
        mesh = createWreath();
        mesh.scale.setScalar(0.9 + Math.random() * 0.4);
      } else if (rand < 0.25) {
        pType = 'BELL';
        mesh = createBell(roseGoldMat);
        mesh.scale.setScalar(0.9 + Math.random() * 0.4); 
      } else if (rand < 0.35) {
        pType = 'ORNAMENT';
        mesh = createApple(glossyRedMat);
      } else if (rand < 0.45) {
        pType = 'ORNAMENT';
        mesh = createSantaHat(feltRedMat);
      } else if (rand < 0.55) {
        pType = 'ORNAMENT';
        mesh = createBow(glossyRedMat);
      } else if (rand < 0.58) {
        pType = 'SNOWFLAKE';
        mesh = new THREE.Mesh(snowflakeGeo, snowflakeMat);
        mesh.scale.setScalar(0.8);
      } else if (rand < 0.73) {
        pType = 'LIGHT';
        mesh = new THREE.Mesh(lightBulbGeo, warmLightMat);
      } else if (rand < 0.83) {
        pType = 'ORNAMENT';
        mesh = new THREE.Mesh(sphereGeo, glowingGoldMat);
      } else if (rand < 0.93) {
        pType = 'STAR_ORNAMENT';
        mesh = new THREE.Mesh(starOrnamentGeo, glowingGoldMat);
        mesh.scale.setScalar(0.8);
      } else if (rand < 0.97) {
        pType = 'GIFT';
        mesh = createGift();
      } else {
        pType = 'CANDY_CANE';
        const group = new THREE.Group();
        const s = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2, 8), caneMat); s.position.y=1;
        const h = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.1, 8, 12, Math.PI), caneMat); h.position.set(0.3, 2, 0);
        group.add(s, h);
        mesh = group;
      }

      const treePos = getTreePos();

      // Orientation
      if (pType === 'BRANCH') {
          mesh.lookAt(0, treePos.y, 0); 
          mesh.rotateX(Math.random() * 0.3); 
      } else if (pType === 'BELL') {
          mesh.rotation.x = (Math.random() - 0.5) * 0.5; 
          mesh.rotation.y = Math.random() * Math.PI * 2;
      } else if (pType === 'SNOWFLAKE') {
          mesh.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
      } else if (mesh.userData.isHat) {
          mesh.rotation.y = Math.random() * Math.PI * 2;
          mesh.rotation.x = (Math.random() - 0.5) * 0.3; 
      } else {
          mesh.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
      }

      const sr = SCATTER_RADIUS * Math.cbrt(Math.random());
      const sPhi = Math.acos(2 * Math.random() - 1);
      const sTheta = 2 * Math.PI * Math.random();
      const scatterPos = new THREE.Vector3(
        sr * Math.sin(sPhi) * Math.cos(sTheta),
        sr * Math.sin(sPhi) * Math.sin(sTheta),
        sr * Math.cos(sPhi)
      );

      mesh.position.copy(scatterPos);
      
      const scale = (0.8 + Math.random() * 0.5) * 1.2;
      mesh.scale.multiplyScalar(scale);

      mainGroup.add(mesh);
      particles.push({
        mesh,
        type: pType,
        treePos,
        scatterPos,
        velocity: new THREE.Vector3().randomDirection().multiplyScalar(0.08),
        rotationSpeed: new THREE.Vector3().random().multiplyScalar(0.04)
      });
    }
    particlesRef.current = particles;

    // 7. Star Topper
    const topperGeo = createStarGeometry(3.5, 0.8);
    const topperMat = new THREE.MeshBasicMaterial({ color: 0xffffff }); 
    const starTopper = new THREE.Mesh(topperGeo, topperMat);
    starTopper.position.y = (TREE_HEIGHT / 2) + 2.5;
    scene.add(starTopper);
    
    // Star Glow
    const starGlow = new THREE.PointLight(COLOR_RICH_GOLD, 1000, 100);
    starGlow.position.copy(starTopper.position);
    scene.add(starGlow);

    // 8. Atmospheric Dust
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = new Float32Array(DUST_COUNT * 3);
    const dustSizes = new Float32Array(DUST_COUNT);
    for(let i=0; i<DUST_COUNT; i++) {
        dustPos[i * 3] = (Math.random() - 0.5) * SCATTER_RADIUS * 3.0;
        dustPos[i * 3 + 1] = (Math.random() - 0.5) * SCATTER_RADIUS * 3.0;
        dustPos[i * 3 + 2] = (Math.random() - 0.5) * SCATTER_RADIUS * 3.0;
        dustSizes[i] = Math.random(); 
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('size', new THREE.BufferAttribute(dustSizes, 1));

    const dustTex = createBokehTexture();
    const dustMat = new THREE.PointsMaterial({
        color: COLOR_ROSE_GOLD, 
        size: 0.6,       
        map: dustTex,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true
    });
    const dustSystem = new THREE.Points(dustGeo, dustMat);
    scene.add(dustSystem);
    atmosphereRef.current = dustSystem;

    // 9. Animation
    const clock = new THREE.Clock();
    const animate = () => {
      const time = clock.getElapsedTime();
      const currentMode = modeRef.current;
      const currentGesture = gestureRef.current;

      // Handle Rotation via Speed Ref (Smoothed by updates in visionLoop)
      rotationOffsetRef.current += rotationSpeedRef.current;
      mainGroup.rotation.y = rotationOffsetRef.current;
      
      starTopper.rotation.y = -time * 0.2;
      starTopper.scale.setScalar((1 + Math.sin(time * 3) * 0.05) * 1.2);

      if (atmosphereRef.current) {
          atmosphereRef.current.rotation.y = -time * 0.01;
          atmosphereRef.current.position.y = Math.sin(time * 0.1) * 1.0;
      }

      // Handle Zoom Logic for Pinch
      let nearestPhoto: Particle | null = null;
      let minDist = Infinity;

      if (currentGesture === 'PINCH_ZOOM') {
          particlesRef.current.forEach(p => {
              if (p.type === 'PHOTO') {
                  const worldPos = new THREE.Vector3();
                  p.mesh.getWorldPosition(worldPos);
                  const dist = worldPos.distanceTo(camera.position);
                  if (dist < minDist) {
                      minDist = dist;
                      nearestPhoto = p;
                  }
              }
          });
      }

      particlesRef.current.forEach(p => {
        let target = new THREE.Vector3();
        let isFocusing = false;

        // Pinch Logic: Focus selected photo, but keep others scattered
        if (currentGesture === 'PINCH_ZOOM' && p === nearestPhoto && p.type === 'PHOTO') {
             isFocusing = true;
             // Move to center, slightly in front of camera
             target.set(0, 5, 55); 
             p.mesh.lookAt(camera.position);
             const targetScale = 6.0;
             p.mesh.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.1);
        }
        
        // If not focusing, determine behavior based on mode
        if (!isFocusing) {
            if (currentMode === AppMode.TREE && currentGesture !== 'PINCH_ZOOM') {
                target.copy(p.treePos);
                if (p.type === 'LIGHT') {
                    const scale = (1 + Math.sin(time * 6 + p.treePos.x) * 0.4) * 1.2;
                    p.mesh.scale.setScalar(scale);
                }
                if (p.type === 'SNOWFLAKE') {
                    p.mesh.rotation.z += 0.01;
                }
                if (p.type === 'PHOTO') {
                    p.mesh.rotation.y += p.rotationSpeed.y * 0.5;
                    p.mesh.scale.lerp(new THREE.Vector3(p.originalScale || 1.0, p.originalScale || 1.0, p.originalScale || 1.0), 0.1);
                } else {
                    p.mesh.rotation.y += p.rotationSpeed.y * 0.5;
                }
            } else {
                // Scatter Mode (OR background behavior during Pinch)
                p.scatterPos.add(p.velocity);
                if (p.scatterPos.length() > SCATTER_RADIUS) p.velocity.negate();
                target.copy(p.scatterPos);
                p.mesh.rotation.x += p.rotationSpeed.x;
                p.mesh.rotation.y += p.rotationSpeed.y;
                if (p.type === 'PHOTO') {
                    p.mesh.scale.lerp(new THREE.Vector3(p.originalScale || 1.0, p.originalScale || 1.0, p.originalScale || 1.0), 0.1);
                }
            }
        }
        
        p.mesh.position.lerp(target, LERP_SPEED);
      });

      composer.render();
      requestAnimationFrame(animate);
    };
    animate();

    // 10. Vision Logic
    let handLandmarker: HandLandmarker | null = null;
    let lastVideoTime = -1;

    // Helper: Detect specific gestures
    const detectGesture = (lm: NormalizedLandmark[]): GestureType => {
        const wrist = lm[0];
        const thumbTip = lm[4];
        const indexTip = lm[8];
        const midTip = lm[12];
        const ringTip = lm[16];
        const pinkyTip = lm[20];

        const d = (a: NormalizedLandmark, b: NormalizedLandmark) => Math.hypot(a.x - b.x, a.y - b.y);
        
        // 1. PINCH (Thumb + Index close)
        if (d(thumbTip, indexTip) < 0.05) {
            return 'PINCH_ZOOM';
        }

        // 2. L-SHAPE (Photo)
        const indexDist = d(indexTip, wrist);
        const midDist = d(midTip, wrist);
        const ringDist = d(ringTip, wrist);
        const pinkyDist = d(pinkyTip, wrist);
        
        if (indexDist > 0.3 && midDist < 0.25 && ringDist < 0.25 && pinkyDist < 0.25) {
             if (d(thumbTip, wrist) > 0.2) return 'L_SHAPE_PHOTO';
        }

        // 3. FIST vs OPEN
        const tips = [indexTip, midTip, ringTip, pinkyTip];
        let totalTipDist = 0;
        tips.forEach(t => totalTipDist += d(t, wrist));
        const avgDist = totalTipDist / 4;

        if (avgDist < 0.25) return 'FIST';
        if (avgDist > 0.35) return 'OPEN_ROTATE';

        return 'NONE';
    };

    const capturePhoto = () => {
        if (!videoRef.current) return;
        
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        const vidW = videoRef.current.videoWidth;
        const vidH = videoRef.current.videoHeight;
        const sSize = Math.min(vidW, vidH);
        const sx = (vidW - sSize) / 2;
        const sy = (vidH - sSize) / 2;

        ctx.translate(512, 0);
        ctx.scale(-1, 1); 
        ctx.drawImage(videoRef.current, sx, sy, sSize, sSize, 0, 0, 512, 512);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        
        const photoGroup = new THREE.Group();
        const frameMat = new THREE.MeshStandardMaterial({ color: 0xffffee, roughness: 0.8, metalness: 0.1 });
        const frameGeo = new THREE.BoxGeometry(4.2, 5.0, 0.1);
        const frame = new THREE.Mesh(frameGeo, frameMat);
        
        const photoMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        const photoGeo = new THREE.PlaneGeometry(3.8, 3.8);
        const photo = new THREE.Mesh(photoGeo, photoMat);
        photo.position.z = 0.06;
        photo.position.y = 0.3;

        const photoBack = photo.clone();
        photoBack.rotation.y = Math.PI;
        photoBack.position.z = -0.06;

        const rimMat = new THREE.MeshStandardMaterial({ color: COLOR_RICH_GOLD, metalness: 1.0, roughness: 0.2 });
        const rim = new THREE.Mesh(new THREE.BoxGeometry(4.3, 5.1, 0.05), rimMat);

        photoGroup.add(frame, photo, photoBack, rim);
        photoGroup.scale.setScalar(0); 

        const treePos = getTreePos();
        treePos.normalize().multiplyScalar(TREE_BASE_RADIUS * 0.8);
        treePos.y = (Math.random() - 0.5) * TREE_HEIGHT * 0.8;

        mainGroup.add(photoGroup);
        
        particlesRef.current.push({
            mesh: photoGroup,
            type: 'PHOTO',
            treePos: treePos,
            scatterPos: new THREE.Vector3().randomDirection().multiplyScalar(SCATTER_RADIUS),
            velocity: new THREE.Vector3().randomDirection().multiplyScalar(0.08),
            rotationSpeed: new THREE.Vector3().random().multiplyScalar(0.02),
            isPhoto: true,
            originalScale: 1.5 
        });
    };

    const setupVision = async () => {
      try {
        setLoadingText("LIGHTING CANDLES");
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });

        // Use the existing video element from Ref
        const v = videoRef.current;
        if (!v) throw new Error("Video element not found");

        // Optimized constraints for Tablets (Magic Pad 2) / Mobile
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: 'user', // Critical: Use front camera for tablet/mobile
                width: { ideal: 640 }, 
                height: { ideal: 480 } 
            } 
        });
        v.srcObject = stream;
        
        await new Promise<void>((resolve) => {
            v.onloadeddata = () => { v.play().catch(console.error); resolve(); }
        });

        setLoadingText("READY");
        setAppMode(AppMode.TREE); 
        modeRef.current = AppMode.TREE;

        const visionLoop = () => {
          if (handLandmarker && v && v.readyState >= 2 && v.currentTime !== lastVideoTime) {
            lastVideoTime = v.currentTime;
            const results = handLandmarker.detectForVideo(v, performance.now());
            
            if (results.landmarks && results.landmarks.length > 0) {
              const lm = results.landmarks[0];
              const detectedGesture = detectGesture(lm);
              gestureRef.current = detectedGesture;

              // --- STATE MACHINE BASED ON GESTURE ---
              
              // 1. L-SHAPE -> PHOTO COUNTDOWN
              if (detectedGesture === 'L_SHAPE_PHOTO') {
                  setDebugInfo("L-SHAPE: PREPARING PHOTO");
                  rotationSpeedRef.current = 0.005; // Reset speed
                  if (!isCountingDownRef.current) {
                      photoModeDebounceRef.current++;
                      if (photoModeDebounceRef.current > 10) { 
                          isCountingDownRef.current = true;
                          setCountdown(3);
                          setShowCamera(true); // SHOW CAMERA
                          let count = 3;
                          const timer = setInterval(() => {
                              count--;
                              if (count > 0) {
                                  setCountdown(count);
                              } else {
                                  clearInterval(timer);
                                  setCountdown(null);
                                  setFlash(true);
                                  capturePhoto();
                                  setTimeout(() => setFlash(false), 150);
                                  setShowCamera(false); // HIDE CAMERA
                                  isCountingDownRef.current = false;
                                  photoModeDebounceRef.current = 0; 
                              }
                          }, 1000);
                      }
                  }
              } else {
                  photoModeDebounceRef.current = 0;
              }

              // 2. OPEN -> SCATTER & ROTATE
              if (detectedGesture === 'OPEN_ROTATE') {
                  setDebugInfo("OPEN HAND: SCATTER & ROTATE");
                  if (modeRef.current !== AppMode.SCATTER) {
                      setAppMode(AppMode.SCATTER);
                      modeRef.current = AppMode.SCATTER;
                  }
                  // Map Palm X (0..1) to Rotation Speed (-0.01 .. 0.01)
                  const palmX = lm[0].x; 
                  // Inverted Logic: Hand moves right (x>0.5) -> rotate right (positive)
                  const speed = (palmX - 0.5) * 0.02; // Max speed 0.01
                  rotationSpeedRef.current = speed;
              }

              // 3. PINCH -> ZOOM (Background Scattered, Photo Focused)
              else if (detectedGesture === 'PINCH_ZOOM') {
                  setDebugInfo("PINCH: INSPECTING MEMORIES");
                  // Force SCATTER mode visually for background items
                  if (modeRef.current !== AppMode.SCATTER) {
                      setAppMode(AppMode.SCATTER);
                      modeRef.current = AppMode.SCATTER;
                  }
                  rotationSpeedRef.current = 0.002; // Very slow spin while inspecting
              }

              // 4. FIST -> GATHER (Fallback/Reset)
              else if (detectedGesture === 'FIST') {
                   setDebugInfo("FIST: HOLDING TREE");
                   if (modeRef.current !== AppMode.TREE) {
                       setAppMode(AppMode.TREE);
                       modeRef.current = AppMode.TREE;
                   }
                   rotationSpeedRef.current = 0.005; // Default slow spin
              }

            } else {
                gestureRef.current = 'NONE';
                setDebugInfo("NO HAND DETECTED");
                rotationSpeedRef.current = 0.005; // Reset to default auto-spin
            }
          }
          requestAnimationFrame(visionLoop);
        };
        visionLoop();

      } catch (err) {
        console.error(err);
        setLoadingText("MOUSE ONLY");
      }
    };
    setupVision();

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (mountRef.current && renderer.domElement) mountRef.current.removeChild(renderer.domElement);
      renderer.dispose();
      if (videoRef.current && videoRef.current.srcObject) {
          (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return (
    <div className="relative w-full h-screen bg-[#050805] overflow-hidden select-none">
      <div ref={mountRef} className="absolute inset-0 z-0" />
      
      {/* CAMERA PREVIEW OVERLAY */}
      <video 
         ref={videoRef} 
         className={`absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-64 h-64 object-cover rounded-2xl border-4 border-[#ffbf00] shadow-[0_0_50px_rgba(255,191,0,0.5)] z-30 transition-all duration-300 ${showCamera ? 'opacity-100 scale-100' : 'opacity-0 scale-90 pointer-events-none'}`}
         playsInline 
         muted 
      />

      {/* FLASH OVERLAY */}
      <div className={`absolute inset-0 z-50 bg-white pointer-events-none transition-opacity duration-150 ${flash ? 'opacity-100' : 'opacity-0'}`} />

      {/* COUNTDOWN OVERLAY */}
      {countdown !== null && (
          <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
              <h1 className="font-cinzel text-[15rem] text-[#ffbf00] animate-ping drop-shadow-[0_0_50px_rgba(255,191,0,0.8)]">
                  {countdown}
              </h1>
          </div>
      )}

      {appMode === AppMode.LOADING && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/95 text-[#ffbf00]">
          <div className="w-16 h-16 border-4 border-t-transparent border-[#ffbf00] rounded-full animate-spin mb-6 shadow-[0_0_20px_#ffbf00]"></div>
          <h2 className="font-cinzel text-xl tracking-[0.3em] animate-pulse text-center px-4">{loadingText}</h2>
        </div>
      )}

      {appMode !== AppMode.LOADING && (
        <div className="absolute inset-0 pointer-events-none z-10 flex flex-col justify-between p-8">
          <div className="w-full text-center">
            <h1 className="font-cinzel text-5xl md:text-7xl text-transparent bg-clip-text bg-gradient-to-b from-[#ffedcc] to-[#ffaa00] drop-shadow-[0_0_30px_rgba(255,170,0,0.6)]">
              NOEL ELEGANCE
            </h1>
            <p className="font-body text-[#ffaa00]/80 text-sm mt-4 tracking-[0.3em] uppercase">
              Interactive Holiday Tree
            </p>
          </div>

          <div className="flex flex-col items-end space-y-4">
             <div className={`transition-all duration-300 transform`}>
                <h3 className="font-cinzel text-[#ffbf00] text-xl text-right drop-shadow-md border-b border-[#ffbf00]/30 pb-1">GESTURES</h3>
                <div className="flex flex-col space-y-2 mt-2">
                    <p className="font-body text-white/70 text-xs text-right tracking-widest">
                       <span className="text-[#ffbf00]">L-SHAPE</span> : TAKE PHOTO
                    </p>
                    <p className="font-body text-white/70 text-xs text-right tracking-widest">
                       <span className="text-[#ffbf00]">OPEN HAND</span> : SCATTER & ROTATE
                    </p>
                    <p className="font-body text-white/70 text-xs text-right tracking-widest">
                       <span className="text-[#ffbf00]">PINCH</span> : INSPECT PHOTO
                    </p>
                    <p className="font-body text-white/70 text-xs text-right tracking-widest">
                       <span className="text-[#ffbf00]">FIST</span> : GATHER TREE
                    </p>
                </div>
             </div>
          </div>

          <div className="text-[#ffbf00]/50 text-[10px] text-center font-mono uppercase tracking-widest">
             {debugInfo}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
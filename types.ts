import * as THREE from 'three';

export enum AppMode {
  LOADING = 'LOADING',
  SCATTER = 'SCATTER',
  TREE = 'TREE'
}

export type ParticleType = 'ORNAMENT' | 'GIFT' | 'CANDY_CANE' | 'STAR_ORNAMENT' | 'BRANCH' | 'BELL' | 'SNOWFLAKE' | 'LIGHT' | 'PHOTO';

export interface Particle {
  mesh: THREE.Object3D;
  type: ParticleType;
  // Target positions
  treePos: THREE.Vector3;
  scatterPos: THREE.Vector3;
  // Physics/Animation props
  velocity: THREE.Vector3;
  rotationSpeed: THREE.Vector3;
  // Specific for photos
  isPhoto?: boolean;
  originalScale?: number;
}
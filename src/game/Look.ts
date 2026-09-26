import { MeshLambertMaterial, MeshStandardMaterial, PMREMGenerator, type MeshLambertMaterialParameters, type Scene, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TOY } from '../theme';

/** Either kind of lit material (Toy Box uses shiny standard ones, the classic island matte Lambert). */
export type LitMat = MeshLambertMaterial | MeshStandardMaterial;

/**
 * A lit material. In Toy Box it's moulded plastic: a proper specular highlight from the sun and a
 * soft studio reflection, so toys, bricks and guns look glossy instead of flat. `roughness` 0.2 is a
 * polished toy, 0.9 felt.
 */
export function plastic(p: MeshLambertMaterialParameters = {}, roughness = 0.42): LitMat {
  if (!TOY) return new MeshLambertMaterial(p);
  return new MeshStandardMaterial({ ...(p as object), roughness, metalness: 0 });
}

let envTex: Texture | null = null;

/** Gives the scenes a soft studio environment for the plastic reflections (Toy Box only). */
export function applyEnvironment(renderer: WebGLRenderer, scenes: Scene[], intensity = 0.15) {
  if (!TOY) return;
  if (!envTex) {
    const pm = new PMREMGenerator(renderer);
    envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
  }
  for (const s of scenes) {
    s.environment = envTex;
    s.environmentIntensity = intensity;
  }
}

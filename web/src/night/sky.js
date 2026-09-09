// 밤하늘. 이미지(HDRI) 없이 그라디언트 + 별 + 지평선 도시광으로 만든다.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { COMMON } from '../util/glsl.js';

export function createSky(uniforms) {
  const g = new THREE.SphereGeometry(4000, 32, 20);
  const m = new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uSkyTop: { value: new THREE.Vector3(...CFG.skyTop) },
      uSkyHorizon: { value: new THREE.Vector3(...CFG.skyHorizon) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        vec4 wp = modelMatrix * vec4(position,1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uSkyTop, uSkyHorizon, uCityGlow, uMoonDir;
      uniform float uTime;
      ${COMMON}
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -1.0, 1.0);

        // 위로 갈수록 어두운 남색, 지평선은 도시 불빛 때문에 갈색빛으로 뜬다
        float t = pow(clamp(h,0.0,1.0), 0.55);
        vec3 col = mix(uSkyHorizon, uSkyTop, t);
        col += uCityGlow * pow(max(0.0, 1.0 - abs(h)*4.5), 3.5) * 0.20;

        // 별 (지평선 근처는 광해로 안 보인다)
        if(h > 0.02){
          vec3 sd = d * 220.0;
          vec3 ci = floor(sd);
          float s = hash13(ci);
          if(s > 0.9955){
            vec3 cf = fract(sd) - 0.5;
            float r = length(cf);
            float tw = 0.65 + 0.35*sin(uTime*1.7 + s*300.0);
            float b = smoothstep(0.18, 0.0, r) * tw * smoothstep(0.02,0.35,h);
            col += vec3(0.85,0.9,1.0) * b * 0.9;
          }
        }

        // 달
        float md = dot(d, normalize(uMoonDir));
        col += vec3(0.9,0.93,1.0) * smoothstep(0.9993, 0.99975, md) * 1.6;
        col += vec3(0.35,0.42,0.6) * pow(max(0.0,md), 220.0) * 0.35;

        // 옅은 구름
        float cl = fbm2(vec2(d.x, d.z) * (2.2/max(0.12,abs(h)+0.12)) + uTime*0.004);
        col = mix(col, col*1.35 + uCityGlow*0.10, smoothstep(0.55,0.85,cl)*smoothstep(0.0,0.35,h)*0.55);

        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  return mesh;
}

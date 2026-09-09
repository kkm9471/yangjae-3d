// 하늘. 이미지(HDRI) 없이 그라디언트 + 별 + 해/달 + 구름으로 만든다.
// 색은 전부 uniform 이라, daycycle.js 가 시각에 따라 갈아 끼운다.

import * as THREE from 'three';
import { COMMON } from '../util/glsl.js';

export function createSky(uniforms) {
  const g = new THREE.SphereGeometry(4000, 40, 24);
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uSkyTop, uSkyHorizon, uCityGlow, uSunDir, uDisk;
      uniform float uTime, uDiskSize, uStars, uDayLight;
      ${COMMON}
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -1.0, 1.0);
        vec3 sd = normalize(uSunDir);

        // 위로 갈수록 짙고, 지평선은 밝다
        float t = pow(clamp(h, 0.0, 1.0), 0.55);
        vec3 col = mix(uSkyHorizon, uSkyTop, t);

        // 해가 있는 쪽 지평선이 더 밝다 (노을이 한쪽에만 생기는 이유)
        vec2 hs = normalize(vec2(sd.x, sd.z) + 1e-5);
        float toSun = max(0.0, dot(normalize(vec2(d.x, d.z) + 1e-5), hs));
        float lowBand = pow(max(0.0, 1.0 - abs(h)*4.5), 3.5);
        col += uCityGlow * lowBand * (0.20 + 0.55*toSun*toSun);

        // 해 근처 하늘이 뿌옇게 밝아진다
        float md = dot(d, sd);
        col += uDisk * 0.010 * pow(max(0.0, md), 12.0);
        col += uDisk * 0.0015 * pow(max(0.0, md), 3.0);

        // 별 (밤에만)
        if(h > 0.02 && uStars > 0.01){
          vec3 sp = d * 220.0;
          vec3 ci = floor(sp);
          float s = hash13(ci);
          if(s > 0.9955){
            float r = length(fract(sp) - 0.5);
            float tw = 0.65 + 0.35*sin(uTime*1.7 + s*300.0);
            col += vec3(0.85,0.9,1.0) * smoothstep(0.18,0.0,r) * tw
                   * smoothstep(0.02,0.35,h) * uStars * 0.9;
          }
        }

        // 해·달 원반
        col += uDisk * smoothstep(uDiskSize - 0.00035, uDiskSize + 0.00005, md);

        // 구름 — 낮에는 희고, 밤에는 도시광을 받아 불그스름하다
        float cl = fbm2(vec2(d.x, d.z) * (2.2/max(0.12, abs(h)+0.12)) + uTime*0.004);
        float cmask = smoothstep(0.60, 0.90, cl) * smoothstep(0.0, 0.30, h);
        vec3 nightCloud = col*1.22 + uCityGlow*0.05;
        vec3 dayCloud = vec3(0.95, 0.97, 1.02) * (0.35 + 0.95*uDayLight);
        col = mix(col, mix(nightCloud, dayCloud, uDayLight), cmask * mix(0.30, 0.72, uDayLight));

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

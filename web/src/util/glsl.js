// 모든 셰이더가 공유하는 조각들.
// 텍스처 파일을 하나도 안 쓰기 때문에, 무늬·창문·노면은 전부 여기 수식으로 만든다.

export const COMMON = /* glsl */`
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 q){ vec3 p3=fract(q*0.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
float noise2(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1.,0.)),f.x),
             mix(hash12(i+vec2(0.,1.)),hash12(i+vec2(1.,1.)),f.x), f.y);
}
float fbm2(vec2 p){ return noise2(p)*0.6 + noise2(p*2.03)*0.26 + noise2(p*4.11)*0.14; }
float box2(vec2 uv, vec2 lo, vec2 hi){
  vec2 s = step(lo, uv) * step(uv, hi);
  return s.x * s.y;
}
`;

export const SCENE_PARS = /* glsl */`
uniform float uTime;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uMoonDir, uMoonColor, uAmbSky, uAmbGround;
uniform vec3  uCityGlow;
varying vec3  vWorld;
`;

// 밤 조명: 하늘/땅 반구광 + 아주 약한 달빛 + 지평선 도시 반사광.
// 실제 광원(PointLight)을 쓰지 않는다 — 수천 개의 불빛을 60fps로 유지하려면
// 빛은 '재질이 스스로 밝은 것'으로 표현하고 번짐은 블룸이 맡는다.
export const SHADE = /* glsl */`
vec3 shadeNight(vec3 N, vec3 base){
  float up = N.y*0.5+0.5;
  vec3 amb = mix(uAmbGround, uAmbSky, up);
  float d  = max(dot(N, normalize(uMoonDir)), 0.0);
  float horizonBounce = pow(1.0 - abs(N.y), 3.0) * 0.55;
  return base * (amb + uMoonColor*d + uCityGlow*horizonBounce*0.20);
}
`;

// 이 화소가 표면 위에서 덮는 거리(m).
// GLSL의 fwidth()는 환경에 따라 쓰레기값이 나올 수 있어서(실측으로 확인함)
// 카메라 거리와 화면 해상도로 직접 계산한다. 어디서나 같은 결과가 나온다.
export const FOOTPRINT = /* glsl */`
uniform float uPixelScale;   // = 2*tan(fov/2) / 화면세로픽셀
float pixelFootprint(vec3 wpos, vec3 N){
  vec3 d = wpos - cameraPosition;
  float dist = length(d);
  // 비스듬히 볼 때 한 축만 늘어나므로 과보정하면 멀쩡한 벽까지 평평해진다
  float graze = max(0.45, abs(dot(normalize(N), d/max(dist,0.001))));
  return dist * uPixelScale / graze;
}
`;

export const FOG_APPLY = /* glsl */`
float fogDist = length(vWorld - cameraPosition);
float fogF = 1.0 - exp(-uFogDensity*uFogDensity*fogDist*fogDist);
// 낮은 곳의 안개는 거리 조명을 머금어 따뜻하게 뜨고, 위로 갈수록 식는다.
vec3 uFogColorH = mix(uFogColor + uCityGlow*0.055, uFogColor, clamp(vWorld.y/110.0, 0.0, 1.0));
#define uFogColor uFogColorH
`;

/** 공통 uniform 묶음을 만든다(한 곳에서 갱신하면 모든 재질에 반영된다) */
export function makeSceneUniforms(THREE, CFG) {
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  return {
    uTime:       { value: 0 },
    uFogColor:   { value: v3(CFG.fogColor) },
    uFogDensity: { value: CFG.fogDensity },
    uMoonDir:    { value: v3(CFG.moonDir).normalize() },
    uMoonColor:  { value: v3(CFG.moonColor) },
    uAmbSky:     { value: v3(CFG.ambSky) },
    uAmbGround:  { value: v3(CFG.ambGround) },
    uCityGlow:   { value: v3(CFG.cityGlow) },
    uLitRatio:   { value: CFG.litRatio },
    uPixelScale: { value: 0.0012 },
  };
}

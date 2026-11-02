/*
 * WebGL Water
 * http://madebyevan.com/webgl-water/
 *
 * Copyright 2011 Evan Wallace
 * Released under the MIT license
 *
 * Modified for the local pool study, 2026-11:
 *   - rectangular pool via the poolHalf uniform (matches a 2:1 pool)
 *   - separate floor and wall tile textures, both supplied by the host page
 *   - water tint, caustic strength and sun highlight tuned for a clear blue pool
 *   - water surface tucked slightly inside the coping
 *   - caustic target explicitly cleared to black
 * All other shader maths and simulation code are unchanged from upstream.
 */

var helperFunctions = '\
  const float IOR_AIR = 1.0;\
  const float IOR_WATER = 1.333;\
  const vec3 abovewaterColor = vec3(0.24, 0.68, 0.92);\
  const vec3 underwaterColor = vec3(0.18, 0.58, 0.88);\
  const float poolHeight = 1.0;\
  uniform vec3 light;\
  uniform vec3 sphereCenter;\
  uniform float sphereRadius;\
  uniform vec2 poolHalf;\
  uniform sampler2D tiles;\
  uniform sampler2D floorTiles;\
  uniform sampler2D causticTex;\
  uniform sampler2D water;\
  \
  vec2 intersectCube(vec3 origin, vec3 ray, vec3 cubeMin, vec3 cubeMax) {\
    vec3 tMin = (cubeMin - origin) / ray;\
    vec3 tMax = (cubeMax - origin) / ray;\
    vec3 t1 = min(tMin, tMax);\
    vec3 t2 = max(tMin, tMax);\
    float tNear = max(max(t1.x, t1.y), t1.z);\
    float tFar = min(min(t2.x, t2.y), t2.z);\
    return vec2(tNear, tFar);\
  }\
  \
  float intersectSphere(vec3 origin, vec3 ray, vec3 sphereCenter, float sphereRadius) {\
    vec3 toSphere = origin - sphereCenter;\
    float a = dot(ray, ray);\
    float b = 2.0 * dot(toSphere, ray);\
    float c = dot(toSphere, toSphere) - sphereRadius * sphereRadius;\
    float discriminant = b*b - 4.0*a*c;\
    if (discriminant > 0.0) {\
      float t = (-b - sqrt(discriminant)) / (2.0 * a);\
      if (t > 0.0) return t;\
    }\
    return 1.0e6;\
  }\
  \
  /* caustic texture is laid out in pool-xz space; keep texels square */\
  vec2 causticSample(vec3 point, vec3 refractedLight) {\
    return 0.75 * (point.xz - point.y * refractedLight.xz / refractedLight.y) / (2.0 * poolHalf.x) + 0.5;\
  }\
  \
  vec3 getSphereColor(vec3 point) {\
    vec3 color = vec3(0.5);\
    \
    /* ambient occlusion with walls */\
    color *= 1.0 - 0.9 / pow((1.0 + sphereRadius - abs(point.x)) / sphereRadius, 3.0);\
    color *= 1.0 - 0.9 / pow((1.0 + sphereRadius - abs(point.z)) / sphereRadius, 3.0);\
    color *= 1.0 - 0.9 / pow((point.y + 1.0 + sphereRadius) / sphereRadius, 3.0);\
    \
    /* caustics */\
    vec3 sphereNormal = (point - sphereCenter) / sphereRadius;\
    vec3 refractedLight = refract(-light, vec3(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);\
    float diffuse = max(0.0, dot(-refractedLight, sphereNormal)) * 0.5;\
    vec4 info = texture2D(water, point.xz / (2.0 * poolHalf) + 0.5);\
    if (point.y < info.r) {\
      vec4 caustic = texture2D(causticTex, causticSample(point, refractedLight));\
      diffuse *= caustic.r * 4.0;\
    }\
    color += diffuse;\
    \
    return color;\
  }\
  \
  vec3 getWallColor(vec3 point) {\
    float scale = 0.92;\
    \
    vec3 wallColor;\
    vec3 normal;\
    float edge = 0.006;\
    if (abs(point.x) > poolHalf.x - edge) {\
      wallColor = texture2D(tiles, point.zy * 0.55 + 0.5).rgb;\
      normal = vec3(-sign(point.x), 0.0, 0.0);\
    } else if (abs(point.z) > poolHalf.y - edge) {\
      wallColor = texture2D(tiles, point.xy * 0.55 + 0.5).rgb;\
      normal = vec3(0.0, 0.0, -sign(point.z));\
    } else {\
      wallColor = texture2D(floorTiles, point.xz / (2.0 * poolHalf) + 0.5).rgb;\
      normal = vec3(0.0, 1.0, 0.0);\
    }\
    \
    scale /= length(vec3(point.x / poolHalf.x, point.y, point.z / poolHalf.y)); /* pool ambient occlusion */\
    scale *= 1.0 - 0.9 / pow(length(point - sphereCenter) / sphereRadius, 4.0); /* sphere ambient occlusion */\
    \
    /* caustics */\
    vec3 refractedLight = -refract(-light, vec3(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);\
    float diffuse = max(0.0, dot(refractedLight, normal));\
    vec4 info = texture2D(water, point.xz / (2.0 * poolHalf) + 0.5);\
    if (point.y < info.r) {\
      vec4 caustic = texture2D(causticTex, causticSample(point, refractedLight));\
      scale += diffuse * caustic.r * 1.1 * caustic.g;\
    } else {\
      /* shadow for the rim of the pool */\
      vec2 t = intersectCube(point, refractedLight, vec3(-poolHalf.x, -poolHeight, -poolHalf.y), vec3(poolHalf.x, 2.0, poolHalf.y));\
      diffuse *= 1.0 / (1.0 + exp(-200.0 / (1.0 + 10.0 * (t.y - t.x)) * (point.y + refractedLight.y * t.y - 2.0 / 12.0)));\
      \
      scale += diffuse * 0.5;\
    }\
    \
    return wallColor * scale;\
  }\
';

function Renderer() {
  this.tileTexture = GL.Texture.fromImage(
    window.__POOL_TILES__ || document.getElementById('tiles'),
    {
      minFilter: gl.LINEAR_MIPMAP_LINEAR,
      wrap: gl.REPEAT,
      format: gl.RGB
    }
  );
  // The floor is sampled with clamped edge
  // coordinates and is never tiled across the pool.
  this.floorTexture = GL.Texture.fromImage(
    window.__POOL_FLOOR__ || window.__POOL_TILES__,
    {
      minFilter: gl.LINEAR_MIPMAP_LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
      format: gl.RGB
    }
  );
  this.poolHalf = window.__POOL_HALF__ ? [window.__POOL_HALF__[0], window.__POOL_HALF__[1]] : [1.0, 1.0];
  this.lightDir = new GL.Vector(2.0, 2.0, -1.0).unit();
  var causticSize = window.__POOL_CAUSTIC_SIZE__ || 1024;
  this.causticTex = new GL.Texture(causticSize, causticSize);
  this.waterMesh = GL.Mesh.plane({ detail: 200 });
  // The water plane and the pool walls share the same boundary, which leaves a
  // sawtooth seam along the waterline. The vertex shader tucks the surface
  // 0.3% inside the coping to hide that edge.
  this.waterShaders = [];
  for (var i = 0; i < 2; i++) {
    this.waterShaders[i] = new GL.Shader('\
      uniform sampler2D water;\
      uniform vec2 poolHalf;\
      varying vec3 position;\
      void main() {\
        vec2 waterUV = gl_Vertex.xy * 0.5 + 0.5;\
        vec4 info = texture2D(water, waterUV);\
        position = vec3(gl_Vertex.x * poolHalf.x * 0.997, info.r, gl_Vertex.y * poolHalf.y * 0.997);\
        gl_Position = gl_ModelViewProjectionMatrix * vec4(position, 1.0);\
      }\
    ', helperFunctions + '\
      uniform vec3 eye;\
      varying vec3 position;\
      uniform samplerCube sky;\
      \
      vec3 getSurfaceRayColor(vec3 origin, vec3 ray, vec3 waterColor) {\
        vec3 color;\
        float q = intersectSphere(origin, ray, sphereCenter, sphereRadius);\
        if (q < 1.0e6) {\
          color = getSphereColor(origin + ray * q);\
        } else if (ray.y < 0.0) {\
          vec2 t = intersectCube(origin, ray, vec3(-poolHalf.x, -poolHeight, -poolHalf.y), vec3(poolHalf.x, 2.0, poolHalf.y));\
          color = getWallColor(origin + ray * t.y);\
        } else {\
          vec2 t = intersectCube(origin, ray, vec3(-poolHalf.x, -poolHeight, -poolHalf.y), vec3(poolHalf.x, 2.0, poolHalf.y));\
          vec3 hit = origin + ray * t.y;\
          if (hit.y < 2.0 / 12.0) {\
            color = getWallColor(hit);\
          } else {\
            color = textureCube(sky, ray).rgb;\
            color += vec3(pow(max(0.0, dot(light, ray)), 5000.0)) * vec3(4.0, 3.2, 2.4);\
          }\
        }\
        if (ray.y < 0.0) color *= waterColor;\
        return color;\
      }\
      \
      void main() {\
        vec2 coord = position.xz / (2.0 * poolHalf) + 0.5;\
        vec4 info = texture2D(water, coord);\
        \
        /* make water look more "peaked" */\
        for (int i = 0; i < 5; i++) {\
          coord += info.ba * 0.005;\
          info = texture2D(water, coord);\
        }\
        \
        vec3 normal = vec3(info.b, sqrt(1.0 - dot(info.ba, info.ba)), info.a);\
        vec3 incomingRay = normalize(position - eye);\
        \
        ' + (i ? /* underwater */ '\
          normal = -normal;\
          vec3 reflectedRay = reflect(incomingRay, normal);\
          vec3 refractedRay = refract(incomingRay, normal, IOR_WATER / IOR_AIR);\
          float fresnel = mix(0.5, 1.0, pow(1.0 - dot(normal, -incomingRay), 3.0));\
          \
          vec3 reflectedColor = getSurfaceRayColor(position, reflectedRay, underwaterColor);\
          vec3 refractedColor = getSurfaceRayColor(position, refractedRay, vec3(1.0)) * vec3(0.84, 1.0, 1.04);\
          \
          gl_FragColor = vec4(mix(reflectedColor, refractedColor, (1.0 - fresnel) * length(refractedRay)), 1.0);\
        ' : /* above water */ '\
          vec3 reflectedRay = reflect(incomingRay, normal);\
          vec3 refractedRay = refract(incomingRay, normal, IOR_AIR / IOR_WATER);\
          float fresnel = mix(0.12, 1.0, pow(1.0 - dot(normal, -incomingRay), 3.0));\
          \
          vec3 reflectedColor = getSurfaceRayColor(position, reflectedRay, abovewaterColor);\
          vec3 refractedColor = getSurfaceRayColor(position, refractedRay, abovewaterColor);\
          \
          gl_FragColor = vec4(mix(refractedColor, reflectedColor, fresnel), 1.0);\
        ') + '\
      }\
    ');
  }
  this.sphereMesh = GL.Mesh.sphere({ detail: 10 });
  this.sphereShader = new GL.Shader(helperFunctions + '\
    varying vec3 position;\
    void main() {\
      position = sphereCenter + gl_Vertex.xyz * sphereRadius;\
      gl_Position = gl_ModelViewProjectionMatrix * vec4(position, 1.0);\
    }\
  ', helperFunctions + '\
    varying vec3 position;\
    void main() {\
      gl_FragColor = vec4(getSphereColor(position), 1.0);\
      vec4 info = texture2D(water, position.xz / (2.0 * poolHalf) + 0.5);\
      if (position.y < info.r) {\
        gl_FragColor.rgb *= underwaterColor * 1.2;\
      }\
    }\
  ');
  this.cubeMesh = GL.Mesh.cube();
  this.cubeMesh.triangles.splice(4, 2);
  this.cubeMesh.compile();
  this.cubeShader = new GL.Shader(helperFunctions + '\
    varying vec3 position;\
    void main() {\
      position = gl_Vertex.xyz;\
      position.x *= poolHalf.x;\
      position.z *= poolHalf.y;\
      position.y = ((1.0 - position.y) * 0.53 - 1.0) * poolHeight;\
      gl_Position = gl_ModelViewProjectionMatrix * vec4(position, 1.0);\
    }\
  ', helperFunctions + '\
    varying vec3 position;\
    void main() {\
      gl_FragColor = vec4(getWallColor(position), 1.0);\
      vec4 info = texture2D(water, position.xz / (2.0 * poolHalf) + 0.5);\
      if (position.y < info.r) {\
        gl_FragColor.rgb *= underwaterColor * 1.2;\
      }\
    }\
  ');
  this.sphereCenter = new GL.Vector();
  this.sphereRadius = 0;
  var hasDerivatives = !!gl.getExtension('OES_standard_derivatives');
  this.causticsShader = new GL.Shader(helperFunctions + '\
    varying vec3 oldPos;\
    varying vec3 newPos;\
    varying vec3 ray;\
    \
    /* project the ray onto the plane */\
    vec3 project(vec3 origin, vec3 ray, vec3 refractedLight) {\
      vec2 tcube = intersectCube(origin, ray, vec3(-poolHalf.x, -poolHeight, -poolHalf.y), vec3(poolHalf.x, 2.0, poolHalf.y));\
      origin += ray * tcube.y;\
      float tplane = (-origin.y - 1.0) / refractedLight.y;\
      return origin + refractedLight * tplane;\
    }\
    \
    void main() {\
      vec4 info = texture2D(water, gl_Vertex.xy * 0.5 + 0.5);\
      info.ba *= 0.5;\
      vec3 normal = vec3(info.b, sqrt(1.0 - dot(info.ba, info.ba)), info.a);\
      \
      /* project the vertices along the refracted vertex ray */\
      vec3 refractedLight = refract(-light, vec3(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);\
      ray = refract(-light, normal, IOR_AIR / IOR_WATER);\
      oldPos = project(gl_Vertex.xzy, refractedLight, refractedLight);\
      newPos = project(gl_Vertex.xzy + vec3(0.0, info.r, 0.0), ray, refractedLight);\
      \
      gl_Position = vec4(0.75 * (newPos.xz + refractedLight.xz / refractedLight.y) / poolHalf.x, 0.0, 1.0);\
    }\
  ', (hasDerivatives ? '#extension GL_OES_standard_derivatives : enable\n' : '') + '\
    ' + helperFunctions + '\
    varying vec3 oldPos;\
    varying vec3 newPos;\
    varying vec3 ray;\
    \
    void main() {\
      ' + (hasDerivatives ? '\
        /* if the triangle gets smaller, it gets brighter, and vice versa */\
        float oldArea = length(dFdx(oldPos)) * length(dFdy(oldPos));\
        float newArea = length(dFdx(newPos)) * length(dFdy(newPos));\
        gl_FragColor = vec4(oldArea / newArea * 0.2, 1.0, 0.0, 0.0);\
      ' : '\
        gl_FragColor = vec4(0.2, 0.2, 0.0, 0.0);\
      ' ) + '\
      \
      vec3 refractedLight = refract(-light, vec3(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);\
      \
      /* compute a blob shadow and make sure we only draw a shadow if the player is blocking the light */\
      vec3 dir = (sphereCenter - newPos) / sphereRadius;\
      vec3 area = cross(dir, refractedLight);\
      float shadow = dot(area, area);\
      float dist = dot(dir, -refractedLight);\
      shadow = 1.0 + (shadow - 1.0) / (0.05 + dist * 0.025);\
      shadow = clamp(1.0 / (1.0 + exp(-shadow)), 0.0, 1.0);\
      shadow = mix(1.0, shadow, clamp(dist * 2.0, 0.0, 1.0));\
      gl_FragColor.g = shadow;\
      \
      /* shadow for the rim of the pool */\
      vec2 t = intersectCube(newPos, -refractedLight, vec3(-poolHalf.x, -poolHeight, -poolHalf.y), vec3(poolHalf.x, 2.0, poolHalf.y));\
      gl_FragColor.r *= 1.0 / (1.0 + exp(-200.0 / (1.0 + 10.0 * (t.y - t.x)) * (newPos.y - refractedLight.y * t.y - 2.0 / 12.0)));\
    }\
  ');
}

Renderer.prototype.updateCaustics = function(water) {
  if (!this.causticsShader) return;
  var this_ = this;
  this.causticTex.drawTo(function() {
    // Local fix: the host scene clears with a light color, so the caustic target
    // must be cleared to black explicitly. Otherwise every texel outside the
    // projected water quad holds ~0.88 and lights the pool floor up as a solid
    // bright block (the "cyan L" seen in the first review screenshot).
    var prevClear = gl.getParameter(gl.COLOR_CLEAR_VALUE);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clearColor(prevClear[0], prevClear[1], prevClear[2], prevClear[3]);
    water.textureA.bind(0);
    this_.causticsShader.uniforms({
      light: this_.lightDir,
      water: 0,
      poolHalf: this_.poolHalf,
      sphereCenter: this_.sphereCenter,
      sphereRadius: this_.sphereRadius
    }).draw(this_.waterMesh);
  });
};

Renderer.prototype.renderWater = function(water, sky) {
  var tracer = new GL.Raytracer();
  water.textureA.bind(0);
  this.tileTexture.bind(1);
  sky.bind(2);
  this.causticTex.bind(3);
  this.floorTexture.bind(4);
  gl.enable(gl.CULL_FACE);
  for (var i = 0; i < 2; i++) {
    gl.cullFace(i ? gl.BACK : gl.FRONT);
    this.waterShaders[i].uniforms({
      light: this.lightDir,
      water: 0,
      tiles: 1,
      sky: 2,
      causticTex: 3,
      floorTiles: 4,
      poolHalf: this.poolHalf,
      eye: tracer.eye,
      sphereCenter: this.sphereCenter,
      sphereRadius: this.sphereRadius
    }).draw(this.waterMesh);
  }
  gl.disable(gl.CULL_FACE);
};

Renderer.prototype.renderSphere = function() {
  water.textureA.bind(0);
  this.causticTex.bind(1);
  this.sphereShader.uniforms({
    light: this.lightDir,
    water: 0,
    causticTex: 1,
    poolHalf: this.poolHalf,
    sphereCenter: this.sphereCenter,
    sphereRadius: this.sphereRadius
  }).draw(this.sphereMesh);
};

Renderer.prototype.renderCube = function() {
  gl.enable(gl.CULL_FACE);
  water.textureA.bind(0);
  this.tileTexture.bind(1);
  this.causticTex.bind(2);
  this.floorTexture.bind(4);
  this.cubeShader.uniforms({
    light: this.lightDir,
    water: 0,
    tiles: 1,
    causticTex: 2,
    floorTiles: 4,
    poolHalf: this.poolHalf,
    sphereCenter: this.sphereCenter,
    sphereRadius: this.sphereRadius
  }).draw(this.cubeMesh);
  gl.disable(gl.CULL_FACE);
};

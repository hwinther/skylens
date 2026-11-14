#!/usr/bin/env node
// Find the rotation that levels a tilted model (used once for the 747 source, whose result is the "pre"
// matrix in models.json): up = the axis of least vertex variance (the wings' plane), then the yaw of best
// mirror symmetry about the fuselage, with the nose at the end away from the tail fin. Prints JSON with
// `pre` (column-major) to paste into models.json. Same npm packages as build-models.mjs (see README.md).
//   node data/models3d/align-tilted.mjs <source.glb>
import { NodeIO } from "@gltf-transform/core";
const doc = await new NodeIO().read(process.argv[2]);
const P = [];
for (const n of doc.getRoot().listNodes()) { const m = n.getMesh(); if (!m) continue; const W = n.getWorldMatrix();
  for (const p of m.listPrimitives()) { const a = p.getAttribute("POSITION"); const v = [0,0,0];
    for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); P.push([W[0]*v[0]+W[4]*v[1]+W[8]*v[2]+W[12], W[1]*v[0]+W[5]*v[1]+W[9]*v[2]+W[13], W[2]*v[0]+W[6]*v[1]+W[10]*v[2]+W[14]]); } } }
const c = [0,1,2].map(k => P.reduce((s, p) => s + p[k], 0) / P.length);
const Q = P.map(p => p.map((x, k) => x - c[k]));
// covariance + jacobi eigen
const C = [[0,0,0],[0,0,0],[0,0,0]]; for (const q of Q) for (let i=0;i<3;i++) for (let j=0;j<3;j++) C[i][j]+=q[i]*q[j]/Q.length;
function jacobi(A){A=A.map(r=>r.slice());let V=[[1,0,0],[0,1,0],[0,0,1]];for(let it=0;it<50;it++){let p=0,q=1;for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)if(Math.abs(A[i][j])>Math.abs(A[p][q])){p=i;q=j}if(Math.abs(A[p][q])<1e-12)break;const th=(A[q][q]-A[p][p])/(2*A[p][q]);const t=Math.sign(th||1)/(Math.abs(th)+Math.sqrt(th*th+1));const cs=1/Math.sqrt(t*t+1),sn=t*cs;for(let k=0;k<3;k++){const akp=A[k][p],akq=A[k][q];A[k][p]=cs*akp-sn*akq;A[k][q]=sn*akp+cs*akq}for(let k=0;k<3;k++){const apk=A[p][k],aqk=A[q][k];A[p][k]=cs*apk-sn*aqk;A[q][k]=sn*apk+cs*aqk}for(let k=0;k<3;k++){const vkp=V[k][p],vkq=V[k][q];V[k][p]=cs*vkp-sn*vkq;V[k][q]=sn*vkp+cs*vkq}}return{vals:[0,1,2].map(i=>A[i][i]),vecs:[0,1,2].map(i=>[V[0][i],V[1][i],V[2][i]])}}
const E = jacobi(C); const order = [0,1,2].sort((a,b)=>E.vals[a]-E.vals[b]);
let up = E.vecs[order[0]]; if (up[1] < 0) up = up.map(x=>-x);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2], cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]], norm=a=>{const l=Math.hypot(...a);return a.map(x=>x/l)};
let e1 = norm(cross(up, [1,0,0])); if (!isFinite(e1[0])) e1 = norm(cross(up,[0,0,1])); const e2 = cross(up, e1);
// local coords
const L = Q.map(q => [dot(q,e1), dot(q,up), dot(q,e2)]);
const sample = L.filter((_, i) => i % 3 === 0);
let best = null;
for (let a = 0; a < 180; a += 0.5) { const r = a*Math.PI/180, f = [Math.cos(r), Math.sin(r)]; // candidate fuselage direction in (e1,e2)
  // mirror across fuselage axis: lateral coordinate flips
  let err = 0; for (const p of sample) { const lon = p[0]*f[0]+p[2]*f[1], lat = -p[0]*f[1]+p[2]*f[0];
    let dmin = Infinity; for (const q of sample) { const lon2 = q[0]*f[0]+q[2]*f[1], lat2 = -q[0]*f[1]+q[2]*f[0]; const d = (lon-lon2)**2 + (lat+lat2)**2 + (p[1]-q[1])**2; if (d < dmin) dmin = d; } err += dmin; }
  if (!best || err < best.err) best = { a, err, f }; }
// fuselage axis in world; nose is the end opposite the highest points (tail fin)
let fw = norm([best.f[0]*e1[0]+best.f[1]*e2[0], best.f[0]*e1[1]+best.f[1]*e2[1], best.f[0]*e1[2]+best.f[1]*e2[2]]);
const top = Q.filter(q => dot(q, up) > 0.6 * Math.max(...Q.map(x => dot(x, up))));
const tailSide = top.reduce((s, q) => s + dot(q, fw), 0) / top.length;
if (tailSide > 0) fw = fw.map(x => -x);
const right = norm(cross(up, fw));
// rotation matrix whose rows map world -> (x=lateral, y=up, z=forward): column-major for glTF
const M = [right[0], up[0], fw[0], 0, right[1], up[1], fw[1], 0, right[2], up[2], fw[2], 0, 0,0,0,1];
console.log(JSON.stringify({ up, fw, yawSearchDeg: best.a, pre: M.map(v=>+v.toFixed(5)) }));

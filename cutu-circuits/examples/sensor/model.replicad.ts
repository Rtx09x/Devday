// Units: mm; Z up. Parametric open-top enclosure, not a verified manufacturing drawing.
import {makeBox} from 'replicad';
export const defaultParams = {width: 54, depth: 40, height: 18, wall: 2};
export default function main(p) {
  const outer = makeBox([-p.width/2,-p.depth/2,0], [p.width/2,p.depth/2,p.height]);
  const inner = makeBox([-p.width/2+p.wall,-p.depth/2+p.wall,p.wall], [p.width/2-p.wall,p.depth/2-p.wall,p.height+1]);
  return [{name: 'sensor-enclosure', shape: outer.cut(inner), color: '#80cbc4'}];
}

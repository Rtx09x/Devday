/** Resolve Myui CSS colors to RGB values accepted by Three's color parser. */
export function readPreviewThemeColors(className: string): {
  background: string;
  mesh: string;
  gridA: string;
  gridB: string;
} {
  const probe = document.createElement('div');
  probe.className = className;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  const resolveColor = (token: string, fallback: string): string => {
    if (!context) return fallback;
    probe.style.color = `var(${token}, ${fallback})`;
    const style = getComputedStyle(probe);
    // The canvas parser understands modern CSS color functions. Composite
    // translucent borders on their surface, since Three.Color has no alpha.
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = style.color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  try {
    return {
      background: resolveColor('--cutucircuits-bg-secondary', '#1e2024'),
      mesh: resolveColor('--cutucircuits-border-focus', '#80cbc4'),
      gridA: resolveColor('--cutucircuits-border', '#3b3d3d'),
      gridB: resolveColor('--cutucircuits-text-faint', '#8b9999'),
    };
  } finally {
    probe.remove();
  }
}

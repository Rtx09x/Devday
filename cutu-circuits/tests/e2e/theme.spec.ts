import {test,expect} from '@playwright/test';
test('presentation theme toggles both ways, persists, and keeps readable text contrast',async({page})=>{
 await page.goto('/');
 await expect(page.getByRole('button',{name:'Switch to dark mode',exact:true})).toBeVisible();
 const ratio=await page.evaluate(()=>{
  const style=getComputedStyle(document.documentElement);
  const lum=(hex:string)=>{const h=hex.trim().replace('#','');const c=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
  return (lum(style.getPropertyValue('--theme-surface'))+.05)/(lum(style.getPropertyValue('--theme-ink-faint'))+.05);
 });
 expect(ratio).toBeGreaterThan(4.5);
 await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-color-mode','dark');
 await page.reload();
 await expect(page.getByRole('button',{name:'Switch to light mode',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-color-mode','light');
 await page.reload();
 await expect(page.getByRole('button',{name:'Switch to dark mode',exact:true})).toBeVisible();
});

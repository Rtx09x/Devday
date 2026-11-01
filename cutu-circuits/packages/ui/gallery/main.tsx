import {useState} from "react";
import type {ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {toast} from "sonner";
import {Button, IconButton, Icon, Input, Switch, Slider, StepSlider, Menu, MenuItem, MenuLabel, ContextMenu, Dialog, Tooltip, SearchField, Kbd, SettingsGroup, SettingsRow, SettingsSelect, SystemMessage, StreamingText, ToastStack, Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator, appThemes, getAppTheme, resolveTheme, iconNames} from "@cutucircuits/ui";
import {materialSurfaceColors} from "@cutucircuits/ui/themes/foundation";
import {ComposerSurface, MessageBubble, SidebarRow} from "@cutucircuits/ui/patterns";
import "./styles.css";

function applyTheme(themeId: string, mode: "dark" | "light") {
  const colors = {...resolveTheme(getAppTheme(themeId)[mode]), ...(themeId === "material" && mode === "dark" ? materialSurfaceColors : {})};
  const root = document.documentElement;
  root.dataset.theme = themeId;
  root.dataset.colorMode = mode;
  root.style.colorScheme = mode;
  for (const [key, color] of Object.entries(colors)) root.style.setProperty(`--theme-${key}`, color);
}

interface SpecimenProps { readonly title: string; readonly description: string; readonly children: ReactNode; readonly wide?: boolean; }
function Specimen({title, description, children, wide}: SpecimenProps) {
  return <section className={`specimen${wide ? " wide" : ""}`}><h2>{title}</h2><p>{description}</p>{children}</section>;
}

function Gallery() {
  const [theme, setTheme] = useState("material");
  const [mode, setMode] = useState<"dark" | "light">("dark");
  const [enabled, setEnabled] = useState(true);
  const [volume, setVolume] = useState(60);
  const [step, setStep] = useState(2);
  const [dialog, setDialog] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState("Overview");
  const [density, setDensity] = useState("comfortable");
  const [streaming, setStreaming] = useState(true);
  const changeTheme = (next: string) => { setTheme(next); applyTheme(next, mode); };
  const changeMode = (light: boolean) => { const next = light ? "light" : "dark"; setMode(next); applyTheme(theme, next); };
  const choices = ["Low", "Balanced", "High", "Maximum"];

  return (
    <main className="gallery">
      <Breadcrumb><BreadcrumbList><BreadcrumbItem><BreadcrumbLink><a href="#">Cutu Circuits</a></BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbPage>Components</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
      <header className="gallery-header">
        <div><p className="mb-2 text-sm text-ink-muted">THE COMPONENT COLLECTION</p><h1 className="text-4xl font-semibold tracking-tight">Cutu Circuits</h1><p className="mt-3 max-w-lg text-sm leading-relaxed text-ink-muted">Quiet surfaces. Compact controls. A shared visual language, ready to compose.</p></div>
        <div className="gallery-controls"><div className="w-40"><SettingsSelect aria-label="Color palette" value={theme} options={appThemes.map(t => ({value:t.id,label:t.name}))} onValueChange={changeTheme} /></div><label className="flex items-center gap-2 text-sm text-ink-muted">Light<Switch aria-label="Light mode" checked={mode === "light"} onCheckedChange={changeMode} /></label></div>
      </header>
      <div className="gallery-grid">
        <Specimen title="Palette & surfaces" description="Semantic colors, translucent overlays, and subtle borders create depth." wide>
          <div className="swatches">{["surface-deep", "surface", "surface-control", "surface-drawer", "surface-popover", "accent"].map(token => <div key={token}><div className="swatch" style={{background:`var(--theme-${token})`}} /><small>{token}</small></div>)}</div>
          <div className="mt-6 flex items-center gap-5"><div className="sidebar-preview w-44" style={theme !== "material" ? {background:"var(--theme-surface-sidebar)"} : undefined} /><p className="text-xs text-ink-muted">Material sidebar gradient<br />180° · #1e2022 → #1b2230</p></div>
        </Specimen>
        <Specimen title="Buttons & tooltips" description="Four treatments, icon controls, shortcuts, and disabled states.">
          <div className="button-row"><Button size="sm" variant="filled" onClick={() => toast.success("Button pressed")}>Filled</Button><Button size="sm" variant="primary" onClick={() => setDialog(true)}>Primary</Button><Button size="sm" variant="ghost" onClick={() => toast.info("Ghost button pressed")}>Ghost</Button><Button size="sm" variant="bare" onClick={() => toast.info("Bare button pressed")}>Bare</Button><Button size="sm" variant="filled" disabled>Disabled</Button><Tooltip content="Add item"><IconButton label="Add item" onClick={() => toast.success("Item added")}><Icon name="plus" /></IconButton></Tooltip><Kbd hotkeys={["Mod+K"]} /></div>
        </Specimen>
        <Specimen title="Text fields" description="Rounded text inputs and the shared search row.">
          <div className="space-y-4"><label className="block text-xs text-ink-muted">Display name<Input className="mt-2" placeholder="Enter a name" /></label><Input aria-label="Disabled input" placeholder="Disabled input" disabled /><SearchField aria-label="Search icons" placeholder="Search icons below…" value={query} onChange={e => setQuery(e.target.value)} trailing={<Kbd hotkeys={["Enter"]} />} /></div>
        </Specimen>
        <Specimen title="Switches & sliders" description="Interactive values with pointer and keyboard controls.">
          <div className="flex items-center justify-between text-sm"><span>Enable option</span><Switch aria-label="Enable option" checked={enabled} onCheckedChange={setEnabled} /></div><div className="mt-4 flex items-center justify-between text-sm text-ink-muted"><span>Disabled switch</span><Switch aria-label="Disabled switch" checked disabled /></div>
          <div className="mt-6"><Slider label="Intensity" value={volume} valueText={`${volume}%`} onValueChange={setVolume} className="w-full" /></div><div className="mt-4"><div className="mb-2 flex justify-between text-xs text-ink-muted"><span>Step slider</span><output>{choices[step]}</output></div><StepSlider label="Level" value={step} maximum={3} valueText={choices[step]} choices={choices.map(label => ({label}))} onChange={setStep} /></div>
        </Specimen>
        <Specimen title="Menus & dialogs" description="Blurred floating surfaces with matching corner geometry and motion.">
          <div className="button-row"><Menu triggerLabel="Open actions" trigger={props => <Button {...props} variant="filled" size="sm">Actions<Icon name="chevron-down" size="xs" /></Button>}><MenuLabel>Options</MenuLabel><MenuItem icon={<Icon name="edit" size="xs" />} onClick={() => setDialog(true)}>Edit appearance</MenuItem><MenuItem icon={<Icon name="copy" size="xs" />} onClick={() => toast.success("Selection copied (demo)")}>Copy selection</MenuItem><MenuItem disabled>Unavailable</MenuItem></Menu><Button variant="primary" size="sm" onClick={() => setDialog(true)}>Open dialog</Button></div>
          <ContextMenu trigger={<div tabIndex={0} className="mt-6 rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-muted">Right-click or use the context-menu key</div>}><MenuItem onClick={() => toast.info("Context action selected")}>Context action</MenuItem></ContextMenu>
        </Specimen>
        <Specimen title="Settings" description="Grouped cards, compact rows, and a portaled select." wide>
          <SettingsGroup title="Preferences"><SettingsRow title="Notifications" description="Show local demo notifications." control={<Switch aria-label="Notifications" checked={enabled} onCheckedChange={setEnabled} />} /><SettingsRow title="Density" description="Choose an example selection." control={<SettingsSelect aria-label="Density" value={density} options={[{value:"comfortable",label:"Comfortable"},{value:"compact",label:"Compact"},{value:"unavailable",label:"Unavailable",disabled:true}]} onValueChange={setDensity} />} /></SettingsGroup>
        </Specimen>
        <Specimen title="Messages & motion" description="Contextual notices and animated text, driven entirely by local example content.">
          <div className="space-y-4"><SystemMessage>Changes are ready to review.</SystemMessage><SystemMessage variant="error">This is an example error state.</SystemMessage><StreamingText text="A subtle fade brings new words into view." streaming={streaming} /><Button size="sm" variant="ghost" className="w-auto" onClick={() => setStreaming(!streaming)}>{streaming ? "Pause animation" : "Resume animation"}</Button></div>
        </Specimen>
        <Specimen title="Notifications" description="The shared toast surface with informational, success, and error states.">
          <div className="button-row"><Button variant="filled" size="sm" onClick={() => toast.success("Appearance updated", {description:"Your demo selection is ready."})}>Success toast</Button><Button variant="primary" size="sm" onClick={() => toast.info("A little more information")}>Info toast</Button><Button variant="ghost" size="sm" onClick={() => toast.error("Example error", {description:"Try the action again."})}>Error toast</Button></div>
        </Specimen>
        <Specimen title="Composed surfaces" description="Sidebar rows, message bubbles, project chips, and the rounded composer shell." wide>
          <div className="demo-layout"><aside className="demo-sidebar cutucircuits-sidebar"><div className="mb-3 px-2 text-sm font-medium text-ink-muted">Collection</div>{["Overview","Components","Appearance"].map(label => <SidebarRow key={label} aria-current={active === label ? "page" : undefined} onClick={() => setActive(label)}><Icon name={label === "Overview" ? "folder" : label === "Components" ? "columns" : "palette"} size="sm" />{label}</SidebarRow>)}</aside><div className="demo-content"><div><p className="mb-3 text-xs text-ink-faint">{active} · example composition</p><MessageBubble className="ml-auto max-w-sm">All the little pieces, working together.</MessageBubble></div><ComposerSurface project={<span className="cutucircuits-project-chip"><Icon name="folder" size="xs" />Example collection</span>} toolbar={<><IconButton label="Attach example" onClick={() => toast.info("Attachment control preview")}><Icon name="paperclip" size="sm" /></IconButton><span className="cutucircuits-model-chip">Example option<Icon name="chevron-down" size="xs" /></span><div className="flex-1" /><IconButton label="Send demo message" disabled={!draft.trim()} className="cutucircuits-send rounded-full bg-ink text-ink-inverse" onClick={() => { toast.success("Demo message sent"); setDraft(""); }}><Icon name="send" size="sm" /></IconButton></>}><textarea aria-label="Demo message" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Write something…" className="min-h-12 w-full resize-none bg-transparent px-2 text-sm outline-none placeholder:text-ink-faint" /></ComposerSurface></div></div>
        </Specimen>
        <Specimen title="Icon collection" description={`${iconNames.length} static SVG glyphs, with shared size and color behavior.`} wide>
          <div className="icon-grid">{iconNames.filter(name => name.toLowerCase().includes(query.toLowerCase())).map(name => <div className="icon-cell" key={name} title={name}><Icon name={name} /><span>{name}</span></div>)}</div>
          {iconNames.every(name => !name.toLowerCase().includes(query.toLowerCase())) && <p className="py-8 text-center text-sm text-ink-muted">No icons match this search.</p>}
        </Specimen>
      </div>
      <Dialog title="Edit appearance" open={dialog} onOpenChange={setDialog}><p className="py-4 text-sm text-ink-muted">A reusable dialog surface with focus management, Escape handling, and a close control.</p><label className="mb-6 block text-sm">Label<Input className="mt-2" defaultValue="Example appearance" /></label><div className="mb-5 flex justify-end"><Button variant="filled" size="sm" className="w-auto" onClick={() => {setDialog(false); toast.success("Appearance saved (demo)");}}>Done</Button></div></Dialog>
      <ToastStack theme={mode} />
      <footer className="mt-10 text-xs text-ink-faint">Cutu Circuits · React primitives and visual foundations</footer>
    </main>
  );
}

applyTheme("material", "dark");
createRoot(document.getElementById("root")!).render(<Gallery />);

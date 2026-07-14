import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { makeTempDir } from "./fs.js";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function installPackedFixture() {
  const root = await makeTempDir();
  const destination = join(root, "packed");
  const consumer = join(root, "consumer");
  const cache = join(root, "npm-cache");
  await mkdir(destination, { recursive: true });
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), '{"name":"changeforge-consumer","private":true,"type":"module"}\n');
  await execa("npm", ["run", "build"], { cwd: packageRoot });
  const env = { ...process.env, npm_config_cache: cache };
  const runtimePackages = await mirrorRuntimeDependencies(destination);
  const packed = await execa("npm", ["pack", "--json", "--silent", "--ignore-scripts", "--pack-destination", destination], {
    cwd: packageRoot,
    env
  });
  const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  await execa("npm", [
    "install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--package-lock=false",
    join(destination, filename), ...runtimePackages
  ], { cwd: consumer, env });
  return consumer;
}

async function mirrorRuntimeDependencies(destination: string) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const listed = await execa("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], {
    cwd: packageRoot,
    reject: false
  });
  const tree = JSON.parse(listed.stdout) as PackageNode;
  const nodes = new Map<string, PackageNode>();
  for (const name of Object.keys(manifest.dependencies)) collect(tree.dependencies?.[name], tree, nodes);
  const copies = new Map([...nodes].map(([source]) => {
    const local = relative(packageRoot, source);
    if (!local || local.startsWith(`..${sep}`)) throw new Error(`Runtime dependency is outside the package: ${source}`);
    return [source, join(destination, "runtime", local)];
  }));
  for (const [source, target] of copies) {
    await cp(source, target, { recursive: true });
  }
  for (const [source, node] of nodes) {
    const target = copies.get(source)!;
    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as Record<string, unknown>;
    packageJson.dependencies = Object.fromEntries(Object.keys(node._dependencies ?? {}).flatMap((name) => {
      const child = dependency(node, tree, name)?.path;
      return child && copies.has(child) ? [[name, `file:${copies.get(child)}`]] : [];
    }));
    delete packageJson.optionalDependencies;
    delete packageJson.peerDependencies;
    await writeFile(join(target, "package.json"), `${JSON.stringify(packageJson)}\n`);
  }
  return Object.keys(manifest.dependencies).map((name) => {
    const source = tree.dependencies?.[name]?.path;
    const target = source && copies.get(source);
    if (!target) throw new Error(`Cannot mirror runtime dependency ${name}.`);
    return `file:${target}`;
  });
}

type PackageNode = {
  name?: string;
  path?: string;
  _dependencies?: Record<string, string>;
  dependencies?: Record<string, PackageNode>;
};

function collect(node: PackageNode | undefined, tree: PackageNode, nodes: Map<string, PackageNode>) {
  if (!node?.path || nodes.has(node.path)) return;
  nodes.set(node.path, node);
  for (const name of Object.keys(node._dependencies ?? {})) collect(dependency(node, tree, name), tree, nodes);
}

function dependency(node: PackageNode, tree: PackageNode, name: string) {
  return node.dependencies?.[name] ?? tree.dependencies?.[name];
}

export async function installedManifest(consumer: string) {
  return JSON.parse(await readFile(join(consumer, "node_modules/changeforge/package.json"), "utf8")) as Record<string, unknown>;
}

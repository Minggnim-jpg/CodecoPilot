import { app, BrowserWindow, nativeImage, dialog } from 'electron';
import path from 'path';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import net from 'net';

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let serverErrors: string[] = [];

const isDev = !app.isPackaged;

function findNodePath(): string {
  // Try to find the system Node.js binary
  const candidates = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    // Use `which` as fallback
  ];

  for (const p of candidates) {
    try {
      execFileSync(p, ['--version'], { timeout: 3000 });
      return p;
    } catch {
      // not found, try next
    }
  }

  // Fallback: use `which node` to find it
  try {
    const result = execFileSync('/usr/bin/which', ['node'], {
      timeout: 3000,
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      },
    });
    return result.toString().trim();
  } catch {
    // Last resort: use Electron as Node
    return process.execPath;
  }
}

function getPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
  });
}

async function waitForServer(port: number, timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // If the server process already exited, fail fast
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(
        `Server process exited with code ${serverProcess.exitCode}.\n\n${serverErrors.join('\n')}`
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const req = require('http').get(`http://127.0.0.1:${port}/api/health`, (res: { statusCode?: number }) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(
    `Server startup timeout after ${timeout / 1000}s.\n\n${serverErrors.length > 0 ? 'Server output:\n' + serverErrors.slice(-10).join('\n') : 'No server output captured.'}`
  );
}

function startServer(port: number): ChildProcess {
  const standaloneDir = path.join(process.resourcesPath, 'standalone');
  const serverPath = path.join(standaloneDir, 'server.js');

  // Always use Electron's built-in Node.js in packaged mode.
  // electron-builder's @electron/rebuild compiles native modules (better-sqlite3)
  // for Electron's Node ABI, so we must use the matching runtime.
  const nodePath = process.execPath;

  console.log(`Using Node.js: ${nodePath}`);
  console.log(`Server path: ${serverPath}`);
  console.log(`Standalone dir: ${standaloneDir}`);

  serverErrors = [];

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    CLAUDE_GUI_DATA_DIR: app.getPath('userData'),
    ELECTRON_RUN_AS_NODE: '1',
    PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
  };

  const child = spawn(nodePath, [serverPath], {
    env,
    stdio: 'pipe',
    cwd: standaloneDir,
  });

  child.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    console.log(`[server] ${msg}`);
    serverErrors.push(msg);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    console.error(`[server:err] ${msg}`);
    serverErrors.push(msg);
  });

  child.on('exit', (code) => {
    console.log(`Server process exited with code ${code}`);
    serverProcess = null;
  });

  return child;
}

function getIconPath(): string {
  if (isDev) {
    return path.join(process.cwd(), 'build', 'icon.png');
  }
  return path.join(process.resourcesPath, 'icon.icns');
}

function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    icon: getIconPath(),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Set macOS Dock icon
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = getIconPath();
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  try {
    let port: number;

    if (isDev) {
      port = 3000;
      console.log(`Dev mode: connecting to http://127.0.0.1:${port}`);
    } else {
      port = await getPort();
      console.log(`Starting server on port ${port}...`);
      serverProcess = startServer(port);
      await waitForServer(port);
      console.log('Server is ready');
    }

    serverPort = port;
    createWindow(port);
  } catch (err) {
    console.error('Failed to start:', err);
    dialog.showErrorBox(
      'CodePilot - Failed to Start',
      `The internal server could not start.\n\n${err instanceof Error ? err.message : String(err)}\n\nPlease try restarting the application.`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      if (!isDev && !serverProcess) {
        const port = await getPort();
        serverProcess = startServer(port);
        await waitForServer(port);
        serverPort = port;
      }
      createWindow(serverPort || 3000);
    } catch (err) {
      console.error('Failed to restart server:', err);
    }
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

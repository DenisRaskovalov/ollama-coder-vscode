// Minimal stub of the 'vscode' module so compiled source files can be
// require()'d in plain Node for unit tests. Only the surface area that
// chatView.ts touches at *module load time* needs to exist.
module.exports = {
  window: {
    activeTextEditor: undefined,
    showWarningMessage: () => {},
    showErrorMessage: () => {},
    showInformationMessage: () => {},
    showInputBox: async () => undefined,
    tabGroups: { all: [] },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (_k, d) => d,
      update: async () => {},
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    asRelativePath: (p) => String(p),
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      readDirectory: async () => [],
      createDirectory: async () => {},
    },
    findFiles: async () => [],
    openTextDocument: async () => ({ uri: {}, getText: () => "" }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async () => {},
  },
  languages: {
    registerInlineCompletionItemProvider: () => ({ dispose() {} }),
  },
  Uri: {
    joinPath: (...parts) => ({ fsPath: parts.join("/"), path: parts.join("/") }),
  },
  Range: class {},
  Position: class {},
  Selection: class {},
  StatusBarAlignment: { Right: 2, Left: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  ProgressLocation: { Notification: 15 },
  TabInputText: class {},
};

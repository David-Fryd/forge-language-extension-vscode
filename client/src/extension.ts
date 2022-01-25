import * as path from 'path';
import * as vscode from 'vscode';
import { workspace, ExtensionContext, Diagnostic, DiagnosticSeverity, DiagnosticCollection, languages } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';
import { ChildProcess, spawn } from 'child_process';
import { error } from 'console';

let client: LanguageClient;

function getTerminal(name: string): vscode.Terminal | null {
	const terms = (<any>vscode.window).terminals;
	for (let i = 0; i < terms.length; i++) {
		if (terms[i].name === name) {
			return terms[i];
		}
	}
	return null;
}

const forgeOutput = vscode.window.createOutputChannel('Forge Output');
let racket: ChildProcess | null;

function parseForgeOutput(line: string): RegExpMatchArray | null {
	const forgeFileReg = /[\\/]*?([^\\/\n\s]*\.frg):(\d+):(\d+):?/;  // assumes no space in filename
	const matcher = (line as string).match(forgeFileReg);
	if (!matcher) {
		return null;
	}
	return matcher;
}

function showFileWithOpts(filePath: string, line: number|null, column: number|null) {

	if (line === null || column === null) {
		vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
	} else {
		const start = new vscode.Position(line, column);
		const end = new vscode.Position(line, column);
		const range = new vscode.Range(start, end);

		const opts: vscode.TextDocumentShowOptions = {
			selection: range
		};

		vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), opts);
	}
}

// languages.onDidChangeDiagnostics(change => {
// 	for (let i=0; i < change.uris.length; i++) {
// 		if (change.uris[i] === vscode.window.activeTextEditor.document.uri) {
// 			console.log("diagnostics changed!");
// 		}
// 	}
// });

function sendEvalErrors(textLine: string, fileURI: vscode.Uri, diagnosticCollectionForgeEval: DiagnosticCollection) {
	const matcher = parseForgeOutput(textLine);
	if (matcher) {

		const line = parseInt(matcher[2]) - 1; 
		const col = parseInt(matcher[3]) - 1;

		const diagnostics: Diagnostic[] = [];

		const start = new vscode.Position(line, col);
		const end = new vscode.Position(line, col + 1); // todo: add length?
		const range = new vscode.Range(start, end);

		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Error,
			range: range,
			message: `Forge Evaluation Error: ${line}`,
			source: 'Racket'
		};
		diagnostics.push(diagnostic);
		diagnosticCollectionForgeEval.set(fileURI, diagnostics);
		showFileWithOpts(fileURI.fsPath, line, col);
	} else {
		showFileWithOpts(fileURI.fsPath, null, null);
	}
}

function subscribeToDocumentChanges(context: vscode.ExtensionContext, myDiagnostics: vscode.DiagnosticCollection): void {

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(e => myDiagnostics.delete(e.document.uri))
	);

	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => myDiagnostics.delete(doc.uri))
	);

}

let racketKilled = false;
function killRacket(manual: boolean) {
	if (racket) {
		racket.kill();
		racketKilled = manual;
		// this is only to inform the user, the process could still be waiting to exit
		forgeOutput.appendLine('Forge process terminated.');
	}
	racket = null;
}

export function activate(context: ExtensionContext) {
	// console.log("Forge Client activated!");

	// inspired by: https://github.com/GrandChris/TerminalRelativePath/blob/main/src/extension.ts
	vscode.window.registerTerminalLinkProvider({
		provideTerminalLinks: (context, token) => {
			const matcher = parseForgeOutput(context.line);
			if (!matcher) {
				return [];
			} else {
				const filename = matcher[1];
				// verify that filename matches?
				const filePath = vscode.window.activeTextEditor.document.uri.fsPath;
				const filePathFilename = filePath.split(/[/\\]/).pop();
				// console.log(`${filePath}: active filename: ${filePathFilename}; filename: ${filename}`);
				if (filePathFilename !== filename) {
					// console.log("the line name is not the active filename");
					return [];
				}

				const line = parseInt(matcher[2]) - 1;
				const col = parseInt(matcher[3]) - 1;

				const tooltip = filePath + `:${line}:${col}`;

				// console.log("matched");
				return [
					{
						startIndex: matcher.index,
						length: matcher[0].length,
						tooltip: tooltip,
						filePath: filePath,
						line: line,
						column: col
					}
				];
			}
		},
		handleTerminalLink: (link: any) => {
			// todo: need to double check if line could be undefined or null
			if (link.line !== undefined) {
				showFileWithOpts(link.filePath, link.line, link.column);
			}
			else {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.file(link.filePath));
			}
		}
	});

	const forgeEvalDiagnostics = languages.createDiagnosticCollection('Forge Eval');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const runFile = vscode.commands.registerCommand('forge.runFile', () => {
		// always auto-save before any run
		vscode.window.activeTextEditor.document.save();

		// // The code you place here will be executed every time your command is executed
		const fileURI = vscode.window.activeTextEditor.document.uri;
		const filepath = fileURI.fsPath;

		// try to only run active forge file
		if (filepath.split(/\./).pop() !== 'frg') {
			vscode.window.showInformationMessage('Click on the Forge file first before hitting the run button :)');
			console.log(`cannot run file ${filepath}`);
			return;
		}

		// if existing racket, kill it first
		killRacket(false);

		forgeOutput.clear();
		forgeOutput.show();

		//Write to output.
		forgeOutput.appendLine(`Running file ${filepath} ...`);

		racket = spawn('racket', [filepath], { shell: true });
		if (!racket) {
			console.error('Cannot spawn Racket process');
		}

		racket.stdout.on('data', (data: string) => {
			forgeOutput.appendLine(data);
		});

		let myStderr = '';
		racket.stderr.on('data', (err: string) => {
			// forgeOutput.appendLine(err);
			myStderr += err;
		});

		racket.on('exit', (code: string) => {
			if (!racketKilled){
				if (myStderr !== '') {
					forgeOutput.appendLine(myStderr);
					sendEvalErrors(myStderr.split(/[\n\r]/)[0], fileURI, forgeEvalDiagnostics);
				} else {
					showFileWithOpts(fileURI.fsPath, null, null);
				}
				forgeOutput.appendLine('Finished running.');
			} else {
				showFileWithOpts(fileURI.fsPath, null, null);
			}
			racketKilled = false;
		});
	});

	const stopRun = vscode.commands.registerCommand('forge.stopRun', () => {
		killRacket(true);
	});

	context.subscriptions.push(runFile, stopRun, forgeEvalDiagnostics);

	subscribeToDocumentChanges(context, forgeEvalDiagnostics);

	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);
	// The debug options for the server
	// --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'forge' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'forgeLanguageServer',
		'Forge Language Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
	console.log('Client and Server launched');
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	// kill racket process
	killRacket(false);
	return client.stop();
}

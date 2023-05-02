/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { addStandardDisposableListener, EventType, addDisposableListener } from 'vs/base/browser/dom';
import { FastDomNode, createFastDomNode } from 'vs/base/browser/fastDomNode';
import { IMouseWheelEvent } from 'vs/base/browser/mouseEvent';
import { IBoundarySashes } from 'vs/base/browser/ui/sash/sash';
import { onUnexpectedError } from 'vs/base/common/errors';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { observableValue } from 'vs/base/common/observable';
import { Constants } from 'vs/base/common/uint';
import { ElementSizeObserver } from 'vs/editor/browser/config/elementSizeObserver';
import { ICodeEditor, IDiffEditor, IDiffEditorConstructionOptions, IDiffLineInformation } from 'vs/editor/browser/editorBrowser';
import { EditorExtensionsRegistry, IDiffEditorContributionDescription } from 'vs/editor/browser/editorExtensions';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from 'vs/editor/browser/widget/codeEditorWidget';
import { IDiffCodeEditorWidgetOptions } from 'vs/editor/browser/widget/diffEditorWidget';
import { IDiffEditorOptions, ValidDiffEditorBaseOptions, clampedFloat, clampedInt, boolean as validateBooleanOption, stringSet as validateStringSetOption } from 'vs/editor/common/config/editorOptions';
import { IDimension } from 'vs/editor/common/core/dimension';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { IRange } from 'vs/editor/common/core/range';
import { ISelection, Selection } from 'vs/editor/common/core/selection';
import { IDiffComputationResult, ILineChange } from 'vs/editor/common/diff/smartLinesDiffComputer';
import { EditorType, IDiffEditorModel, IDiffEditorViewState, IEditorAction, IEditorDecorationsCollection, ScrollType } from 'vs/editor/common/editorCommon';
import { IModelDecorationsChangeAccessor, IModelDeltaDecoration } from 'vs/editor/common/model';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IEditorProgressService } from 'vs/platform/progress/common/progress';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { Event } from 'vs/base/common/event';


export class DiffEditorWidget extends Disposable implements IDiffEditor {
	public static counter = 0;

	private readonly _id = ++DiffEditorWidget.counter;
	private readonly _modifiedEditor: CodeEditorWidget;
	private readonly _originalEditor: CodeEditorWidget;
	private readonly _instantiationService: IInstantiationService;
	private readonly _contextKeyService: IContextKeyService;
	private readonly _containerDomElement: HTMLDivElement;
	private readonly _overviewViewportDomElement: FastDomNode<HTMLDivElement>;
	private readonly _overviewDomElement: HTMLDivElement;
	private readonly _originalDomNode: HTMLDivElement;
	private readonly _modifiedDomNode: HTMLDivElement;
	private readonly _elementSizeObserver: ElementSizeObserver;
	private _options: ValidDiffEditorBaseOptions;

	private readonly model = observableValue<IDiffEditorModel | null>('diffEditorModel', null);
	public readonly onDidChangeModel = Event.fromObservableLight(this.model);

	constructor(
		private readonly _domElement: HTMLElement,
		options: Readonly<IDiffEditorConstructionOptions>,
		codeEditorWidgetOptions: IDiffCodeEditorWidgetOptions,
		@IClipboardService clipboardService: IClipboardService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IThemeService private readonly _themeService: IThemeService,
		@INotificationService notificationService: INotificationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IEditorProgressService private readonly _editorProgressService: IEditorProgressService
	) {
		super();
		_codeEditorService.willCreateDiffEditor();

		this._contextKeyService = this._register(contextKeyService.createScoped(_domElement));
		this._contextKeyService.createKey('isInDiffEditor', true);
		if (typeof options.isInEmbeddedEditor !== 'undefined') {
			this._contextKeyService.createKey('isInEmbeddedDiffEditor', options.isInEmbeddedEditor);
		} else {
			this._contextKeyService.createKey('isInEmbeddedDiffEditor', false);
		}

		this._instantiationService = instantiationService.createChild(new ServiceCollection([IContextKeyService, this._contextKeyService]));

		this._options = validateDiffEditorOptions(options || {}, {
			enableSplitViewResizing: true,
			splitViewDefaultRatio: 0.5,
			renderSideBySide: true,
			renderMarginRevertIcon: true,
			maxComputationTime: 5000,
			maxFileSize: 50,
			ignoreTrimWhitespace: true,
			renderIndicators: true,
			originalEditable: false,
			diffCodeLens: false,
			renderOverviewRuler: true,
			diffWordWrap: 'inherit',
			diffAlgorithm: 'advanced',
			accessibilityVerbose: false
		});

		this._overviewViewportDomElement = createFastDomNode(document.createElement('div'));
		this._overviewViewportDomElement.setClassName('diffViewport');
		this._overviewViewportDomElement.setPosition('absolute');

		this._overviewDomElement = document.createElement('div');
		this._overviewDomElement.className = 'diffOverview';
		this._overviewDomElement.style.position = 'absolute';
		this._overviewDomElement.appendChild(this._overviewViewportDomElement.domNode);
		this._register(addStandardDisposableListener(this._overviewDomElement, EventType.POINTER_DOWN, (e) => {
			this._modifiedEditor.delegateVerticalScrollbarPointerDown(e);
		}));
		this._register(addDisposableListener(this._overviewDomElement, EventType.MOUSE_WHEEL, (e: IMouseWheelEvent) => {
			this._modifiedEditor.delegateScrollFromMouseWheelEvent(e);
		}, { passive: false }));

		// Create left side
		this._originalDomNode = document.createElement('div');
		this._originalDomNode.className = 'editor original';
		this._originalDomNode.style.position = 'absolute';
		this._originalDomNode.style.height = '100%';

		// Create right side
		this._modifiedDomNode = document.createElement('div');
		this._modifiedDomNode.className = 'editor modified';
		this._modifiedDomNode.style.position = 'absolute';
		this._modifiedDomNode.style.height = '100%';

		this._register(this._themeService.onDidColorThemeChange(t => {
			/*if (this._strategy && this._strategy.applyColors(t)) {
				this._updateDecorationsRunner.schedule();
			}*/
			//this._containerDomElement.className = DiffEditorWidget._getClassName(this._themeService.getColorTheme(), this._options.renderSideBySide);
		}));

		this._containerDomElement = document.createElement('div');
		this._containerDomElement.className = DiffEditorWidget._getClassName(this._themeService.getColorTheme(), this._options.renderSideBySide);
		this._containerDomElement.style.position = 'relative';
		this._containerDomElement.style.height = '100%';
		if (this._options.renderOverviewRuler) {
			this._containerDomElement.appendChild(this._overviewDomElement);
		}
		this._containerDomElement.appendChild(this._originalDomNode);
		this._containerDomElement.appendChild(this._modifiedDomNode);
		this._domElement.appendChild(this._containerDomElement);

		this._elementSizeObserver = this._register(new ElementSizeObserver(this._containerDomElement, options.dimension));
		this._register(this._elementSizeObserver.onDidChange(() => this._onDidContainerSizeChanged()));
		if (options.automaticLayout) {
			this._elementSizeObserver.startObserving();
		}

		this._originalEditor = this._createLeftHandSideEditor(options, codeEditorWidgetOptions.originalEditor || {});
		this._modifiedEditor = this._createRightHandSideEditor(options, codeEditorWidgetOptions.modifiedEditor || {});

		const contributions: IDiffEditorContributionDescription[] = EditorExtensionsRegistry.getDiffEditorContributions();
		for (const desc of contributions) {
			try {
				this._register(instantiationService.createInstance(desc.ctor, this));
			} catch (err) {
				onUnexpectedError(err);
			}
		}

		this._codeEditorService.addDiffEditor(this);
	}
	static _getClassName(arg0: any, renderSideBySide: boolean): any {
		throw new Error('Method not implemented.');
	}

	_onDidContainerSizeChanged() {
		throw new Error('Method not implemented.');
	}
	_createLeftHandSideEditor(options: Readonly<IDiffEditorConstructionOptions>, arg1: ICodeEditorWidgetOptions): any {
		throw new Error('Method not implemented.');
	}
	_createRightHandSideEditor(options: Readonly<IDiffEditorConstructionOptions>, arg1: ICodeEditorWidgetOptions): CodeEditorWidget {
		throw new Error('Method not implemented.');
	}




	getContainerDomNode(): HTMLElement {
		return this._domElement;
	}

	public readonly onDidUpdateDiff: Event<void> = e => {
		return { dispose: () => { } };
	};

	saveViewState(): IDiffEditorViewState | null {
		throw new Error('Method not implemented.');
	}
	restoreViewState(state: IDiffEditorViewState | null): void {
		throw new Error('Method not implemented.');
	}

	getModel(): IDiffEditorModel | null { return this.model.get(); }
	setModel(model: IDiffEditorModel | null): void {
		this.model.set(model, undefined);
	}

	getOriginalEditor(): ICodeEditor { return this._originalEditor; }
	getModifiedEditor(): ICodeEditor { return this._modifiedEditor; }

	updateOptions(newOptions: IDiffEditorOptions): void {
		throw new Error('Method not implemented.');
	}
	setBoundarySashes(sashes: IBoundarySashes): void {
		throw new Error('Method not implemented.');
	}
	onDidDispose(listener: () => void): IDisposable {
		throw new Error('Method not implemented.');
	}
	getId(): string { return this.getEditorType() + ':' + this._id; }
	getEditorType(): string { return EditorType.IDiffEditor; }
	onVisible(): void {
		throw new Error('Method not implemented.');
	}
	onHide(): void {
		throw new Error('Method not implemented.');
	}
	layout(dimension?: IDimension | undefined): void {
		throw new Error('Method not implemented.');
	}
	hasTextFocus(): boolean {
		return this._originalEditor.hasTextFocus() || this._modifiedEditor.hasTextFocus();
	}

	// #region legacy

	public get ignoreTrimWhitespace(): boolean {
		return this._options.ignoreTrimWhitespace;
	}

	public get maxComputationTime(): number {
		return this._options.maxComputationTime;
	}

	public get renderSideBySide(): boolean {
		return this._options.renderSideBySide;
	}

	getLineChanges(): ILineChange[] | null {
		throw new Error('Method not implemented.');
	}
	getDiffComputationResult(): IDiffComputationResult | null {
		throw new Error('Method not implemented.');
	}
	getDiffLineInformationForOriginal(lineNumber: number): IDiffLineInformation | null {
		throw new Error('Method not implemented.');
	}
	getDiffLineInformationForModified(lineNumber: number): IDiffLineInformation | null {
		throw new Error('Method not implemented.');
	}
	// #endregion

	// #region editorBrowser.IDiffEditor: Delegating to modified Editor

	public getVisibleColumnFromPosition(position: IPosition): number {
		return this._modifiedEditor.getVisibleColumnFromPosition(position);
	}

	public getStatusbarColumn(position: IPosition): number {
		return this._modifiedEditor.getStatusbarColumn(position);
	}

	public getPosition(): Position | null {
		return this._modifiedEditor.getPosition();
	}

	public setPosition(position: IPosition, source: string = 'api'): void {
		this._modifiedEditor.setPosition(position, source);
	}

	public revealLine(lineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLine(lineNumber, scrollType);
	}

	public revealLineInCenter(lineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLineInCenter(lineNumber, scrollType);
	}

	public revealLineInCenterIfOutsideViewport(lineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLineInCenterIfOutsideViewport(lineNumber, scrollType);
	}

	public revealLineNearTop(lineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLineNearTop(lineNumber, scrollType);
	}

	public revealPosition(position: IPosition, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealPosition(position, scrollType);
	}

	public revealPositionInCenter(position: IPosition, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealPositionInCenter(position, scrollType);
	}

	public revealPositionInCenterIfOutsideViewport(position: IPosition, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealPositionInCenterIfOutsideViewport(position, scrollType);
	}

	public revealPositionNearTop(position: IPosition, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealPositionNearTop(position, scrollType);
	}

	public getSelection(): Selection | null {
		return this._modifiedEditor.getSelection();
	}

	public getSelections(): Selection[] | null {
		return this._modifiedEditor.getSelections();
	}

	public setSelection(range: IRange, source?: string): void;
	public setSelection(editorRange: Range, source?: string): void;
	public setSelection(selection: ISelection, source?: string): void;
	public setSelection(editorSelection: Selection, source?: string): void;
	public setSelection(something: any, source: string = 'api'): void {
		this._modifiedEditor.setSelection(something, source);
	}

	public setSelections(ranges: readonly ISelection[], source: string = 'api'): void {
		this._modifiedEditor.setSelections(ranges, source);
	}

	public revealLines(startLineNumber: number, endLineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLines(startLineNumber, endLineNumber, scrollType);
	}

	public revealLinesInCenter(startLineNumber: number, endLineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLinesInCenter(startLineNumber, endLineNumber, scrollType);
	}

	public revealLinesInCenterIfOutsideViewport(startLineNumber: number, endLineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLinesInCenterIfOutsideViewport(startLineNumber, endLineNumber, scrollType);
	}

	public revealLinesNearTop(startLineNumber: number, endLineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLinesNearTop(startLineNumber, endLineNumber, scrollType);
	}

	public revealRange(range: IRange, scrollType: ScrollType = ScrollType.Smooth, revealVerticalInCenter: boolean = false, revealHorizontal: boolean = true): void {
		this._modifiedEditor.revealRange(range, scrollType, revealVerticalInCenter, revealHorizontal);
	}

	public revealRangeInCenter(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeInCenter(range, scrollType);
	}

	public revealRangeInCenterIfOutsideViewport(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeInCenterIfOutsideViewport(range, scrollType);
	}

	public revealRangeNearTop(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeNearTop(range, scrollType);
	}

	public revealRangeNearTopIfOutsideViewport(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeNearTopIfOutsideViewport(range, scrollType);
	}

	public revealRangeAtTop(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeAtTop(range, scrollType);
	}

	public getSupportedActions(): IEditorAction[] {
		return this._modifiedEditor.getSupportedActions();
	}

	public focus(): void {
		this._modifiedEditor.focus();
	}

	public trigger(source: string | null | undefined, handlerId: string, payload: any): void {
		this._modifiedEditor.trigger(source, handlerId, payload);
	}

	public createDecorationsCollection(decorations?: IModelDeltaDecoration[]): IEditorDecorationsCollection {
		return this._modifiedEditor.createDecorationsCollection(decorations);
	}

	public changeDecorations(callback: (changeAccessor: IModelDecorationsChangeAccessor) => any): any {
		return this._modifiedEditor.changeDecorations(callback);
	}

	// #endregion
}

function validateDiffEditorOptions(options: Readonly<IDiffEditorOptions>, defaults: ValidDiffEditorBaseOptions): ValidDiffEditorBaseOptions {
	return {
		enableSplitViewResizing: validateBooleanOption(options.enableSplitViewResizing, defaults.enableSplitViewResizing),
		splitViewDefaultRatio: clampedFloat(options.splitViewDefaultRatio, 0.5, 0.1, 0.9),
		renderSideBySide: validateBooleanOption(options.renderSideBySide, defaults.renderSideBySide),
		renderMarginRevertIcon: validateBooleanOption(options.renderMarginRevertIcon, defaults.renderMarginRevertIcon),
		maxComputationTime: clampedInt(options.maxComputationTime, defaults.maxComputationTime, 0, Constants.MAX_SAFE_SMALL_INTEGER),
		maxFileSize: clampedInt(options.maxFileSize, defaults.maxFileSize, 0, Constants.MAX_SAFE_SMALL_INTEGER),
		ignoreTrimWhitespace: validateBooleanOption(options.ignoreTrimWhitespace, defaults.ignoreTrimWhitespace),
		renderIndicators: validateBooleanOption(options.renderIndicators, defaults.renderIndicators),
		originalEditable: validateBooleanOption(options.originalEditable, defaults.originalEditable),
		diffCodeLens: validateBooleanOption(options.diffCodeLens, defaults.diffCodeLens),
		renderOverviewRuler: validateBooleanOption(options.renderOverviewRuler, defaults.renderOverviewRuler),
		diffWordWrap: validateDiffWordWrap(options.diffWordWrap, defaults.diffWordWrap),
		diffAlgorithm: validateStringSetOption(options.diffAlgorithm, defaults.diffAlgorithm, ['legacy', 'advanced'], { 'smart': 'legacy', 'experimental': 'advanced' }),
		accessibilityVerbose: validateBooleanOption(options.accessibilityVerbose, defaults.accessibilityVerbose),
	};
}

function validateDiffWordWrap(value: 'off' | 'on' | 'inherit' | undefined, defaultValue: 'off' | 'on' | 'inherit'): 'off' | 'on' | 'inherit' {
	return validateStringSetOption<'off' | 'on' | 'inherit'>(value, defaultValue, ['off', 'on', 'inherit']);
}

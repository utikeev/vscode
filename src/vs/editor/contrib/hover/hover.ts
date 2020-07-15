/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeyChord, KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { DisposableStore, IDisposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { IEmptyContentData } from 'vs/editor/browser/controller/mouseTarget';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { EditorAction, registerEditorAction, registerEditorContribution, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { ConfigurationChangedEvent, EditorOption } from 'vs/editor/common/config/editorOptions';
import { Range } from 'vs/editor/common/core/range';
import { IPosition } from 'vs/editor/common/core/position';
import { IEditorContribution, IScrollEvent } from 'vs/editor/common/editorCommon';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { IModeService } from 'vs/editor/common/services/modeService';
import { HoverStartMode } from 'vs/editor/contrib/hover/hoverOperation';
import { ModesContentHoverWidget } from 'vs/editor/contrib/hover/modesContentHover';
import { ModesGlyphHoverWidget } from 'vs/editor/contrib/hover/modesGlyphHover';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import {
	editorHoverBackground,
	editorHoverBorder,
	editorHoverForeground,
	editorHoverHighlight,
	editorHoverStatusBarBackground,
	textCodeBlockBackground,
	textLinkForeground
} from 'vs/platform/theme/common/colorRegistry';
import { IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { IMarkerDecorationsService } from 'vs/editor/common/services/markersDecorationService';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { AccessibilitySupport } from 'vs/platform/accessibility/common/accessibility';
import { GotoDefinitionAtPositionEditorContribution } from 'vs/editor/contrib/gotoSymbol/link/goToDefinitionAtPosition';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { HoverSource } from 'vs/editor/common/modes';
import { URI } from 'vs/base/common/uri';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { IModelService } from 'vs/editor/common/services/modelService';

export class ModesHoverController implements IEditorContribution {

	public static readonly ID = 'editor.contrib.hover';

	private readonly _toUnhook = new DisposableStore();
	private readonly _didChangeConfigurationHandler: IDisposable;

	private readonly _contentWidget = new MutableDisposable<ModesContentHoverWidget>();
	private readonly _glyphWidget = new MutableDisposable<ModesGlyphHoverWidget>();

	get contentWidget(): ModesContentHoverWidget {
		if (!this._contentWidget.value) {
			this._createHoverWidgets();
		}
		return this._contentWidget.value!;
	}

	get glyphWidget(): ModesGlyphHoverWidget {
		if (!this._glyphWidget.value) {
			this._createHoverWidgets();
		}
		return this._glyphWidget.value!;
	}

	private _isMouseDown: boolean;
	private _hoverClicked: boolean;
	private _isHoverEnabled!: boolean;
	private _isHoverSticky!: boolean;
	private _isCurrentSticky: boolean = false;

	private _hoverVisibleKey: IContextKey<boolean>;

	static get(editor: ICodeEditor): ModesHoverController {
		return editor.getContribution<ModesHoverController>(ModesHoverController.ID);
	}

	constructor(private readonly _editor: ICodeEditor,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IModeService private readonly _modeService: IModeService,
		@IMarkerDecorationsService private readonly _markerDecorationsService: IMarkerDecorationsService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IThemeService private readonly _themeService: IThemeService,
		@IContextKeyService _contextKeyService: IContextKeyService
	) {
		this._isMouseDown = false;
		this._hoverClicked = false;
		this._hoverVisibleKey = EditorContextKeys.hoverVisible.bindTo(_contextKeyService);

		this._hookEvents();

		this._didChangeConfigurationHandler = this._editor.onDidChangeConfiguration((e: ConfigurationChangedEvent) => {
			if (e.hasChanged(EditorOption.hover)) {
				this._hideWidgets();
				this._unhookEvents();
				this._hookEvents();
			}
		});
	}

	private _hookEvents(): void {
		const hideWidgetsEventHandler = () => {
			if (!this._isCurrentSticky) {
				this._hideWidgets();
			}
		};

		const hoverOpts = this._editor.getOption(EditorOption.hover);
		this._isHoverEnabled = hoverOpts.enabled;
		this._isHoverSticky = hoverOpts.sticky;
		if (this._isHoverEnabled) {
			this._toUnhook.add(this._editor.onMouseDown((e: IEditorMouseEvent) => this._onEditorMouseDown(e)));
			this._toUnhook.add(this._editor.onMouseUp((e: IEditorMouseEvent) => this._onEditorMouseUp(e)));
			this._toUnhook.add(this._editor.onMouseMove((e: IEditorMouseEvent) => this._onEditorMouseMove(e)));
			this._toUnhook.add(this._editor.onKeyDown((e: IKeyboardEvent) => this._onKeyDown(e)));
			this._toUnhook.add(this._editor.onDidChangeModelDecorations(() => this._onModelDecorationsChanged()));
			this._toUnhook.add(this.contentWidget.onBlur(() => this._onWidgetBlur()));
		} else {
			this._toUnhook.add(this._editor.onMouseMove(hideWidgetsEventHandler));
		}

		this._toUnhook.add(this._editor.onMouseLeave(hideWidgetsEventHandler));
		this._toUnhook.add(this._editor.onDidChangeModel(hideWidgetsEventHandler));
		this._toUnhook.add(this._editor.onDidScrollChange((e: IScrollEvent) => this._onEditorScrollChanged(e)));
	}

	private _unhookEvents(): void {
		this._toUnhook.clear();
	}

	private _onModelDecorationsChanged(): void {
		this.contentWidget.onModelDecorationsChanged();
		this.glyphWidget.onModelDecorationsChanged();
	}

	private _onEditorScrollChanged(e: IScrollEvent): void {
		if (e.scrollTopChanged || e.scrollLeftChanged) {
			this._hideWidgets();
		}
	}

	private _onEditorMouseDown(mouseEvent: IEditorMouseEvent): void {
		this._isMouseDown = true;

		const targetType = mouseEvent.target.type;

		if (targetType === MouseTargetType.CONTENT_WIDGET && mouseEvent.target.detail === ModesContentHoverWidget.ID) {
			this._hoverClicked = true;
			// mouse down on top of content hover widget
			return;
		}

		if (targetType === MouseTargetType.OVERLAY_WIDGET && mouseEvent.target.detail === ModesGlyphHoverWidget.ID) {
			// mouse down on top of overlay hover widget
			return;
		}

		if (targetType !== MouseTargetType.OVERLAY_WIDGET && mouseEvent.target.detail !== ModesGlyphHoverWidget.ID) {
			this._hoverClicked = false;
		}

		this._hideWidgets();
	}

	private _onEditorMouseUp(mouseEvent: IEditorMouseEvent): void {
		this._isMouseDown = false;
	}

	private _onEditorMouseMove(mouseEvent: IEditorMouseEvent): void {
		let targetType = mouseEvent.target.type;

		if (this._isMouseDown && this._hoverClicked && this.contentWidget.isColorPickerVisible()) {
			return;
		}

		if (this._isHoverSticky && targetType === MouseTargetType.CONTENT_WIDGET && mouseEvent.target.detail === ModesContentHoverWidget.ID) {
			// mouse moved on top of content hover widget
			return;
		}

		if (this._isHoverSticky && targetType === MouseTargetType.OVERLAY_WIDGET && mouseEvent.target.detail === ModesGlyphHoverWidget.ID) {
			// mouse moved on top of overlay hover widget
			return;
		}

		if (this._isCurrentSticky) {
			return;
		}

		if (targetType === MouseTargetType.CONTENT_EMPTY) {
			const epsilon = this._editor.getOption(EditorOption.fontInfo).typicalHalfwidthCharacterWidth / 2;
			const data = <IEmptyContentData>mouseEvent.target.detail;
			if (data && !data.isAfterLines && typeof data.horizontalDistanceToText === 'number' && data.horizontalDistanceToText < epsilon) {
				// Let hover kick in even when the mouse is technically in the empty area after a line, given the distance is small enough
				targetType = MouseTargetType.CONTENT_TEXT;
			}
		}

		if (targetType === MouseTargetType.CONTENT_TEXT) {
			this.glyphWidget.hide();

			if (this._isHoverEnabled && mouseEvent.target.range) {
				const modifiers = ModesHoverController.getModifiers(mouseEvent);
				this.contentWidget.startShowingAt(mouseEvent.target.range, HoverStartMode.Delayed, false, HoverSource.Mouse, modifiers);
			}
		} else if (targetType === MouseTargetType.GUTTER_GLYPH_MARGIN) {
			this.contentWidget.hide();

			if (this._isHoverEnabled && mouseEvent.target.position) {
				this.glyphWidget.startShowingAt(mouseEvent.target.position.lineNumber);
			}
		} else {
			this._hideWidgets();
		}
	}

	private static getModifiers(e: IEditorMouseEvent): KeyMod[] {
		const modifiers: KeyMod[] = [];
		const mouseEvent = e.event;
		if (mouseEvent.altKey) {
			modifiers.push(KeyMod.Alt);
		}
		if (mouseEvent.ctrlKey) {
			modifiers.push(KeyMod.WinCtrl);
		}
		if (mouseEvent.metaKey) {
			modifiers.push(KeyMod.CtrlCmd);
		}
		if (mouseEvent.shiftKey) {
			modifiers.push(KeyMod.Shift);
		}
		return modifiers;
	}

	private _onKeyDown(e: IKeyboardEvent): void {
		if (this._isCurrentSticky && e.keyCode !== KeyCode.Escape) {
			return;
		}

		if (!e.toKeybinding().isModifierKey()) {
			// Do not hide hover when a modifier key is pressed
			this._hideWidgets();
		}
	}

	public _onWidgetBlur() {
		if (this._isCurrentSticky) {
			this._hideWidgets();
		}
	}

	private _hideWidgets(): void {
		if (!this._glyphWidget.value || !this._contentWidget.value || (this._isMouseDown && this._hoverClicked && this._contentWidget.value.isColorPickerVisible())) {
			return;
		}

		this._isCurrentSticky = false;
		this._glyphWidget.value.hide();
		this._contentWidget.value.hide();
	}

	private _createHoverWidgets() {
		this._contentWidget.value = new ModesContentHoverWidget(this._editor, this._hoverVisibleKey, this._markerDecorationsService, this._keybindingService, this._themeService, this._modeService, this._openerService);
		this._glyphWidget.value = new ModesGlyphHoverWidget(this._editor, this._modeService, this._openerService);
	}

	public showContentHover(range: Range, mode: HoverStartMode, focus: boolean, sticky?: boolean): void {
		this._isCurrentSticky = !!sticky;
		this.contentWidget.startShowingAt(range, mode, focus, HoverSource.Action, [], this._isCurrentSticky);
	}

	public dispose(): void {
		this._unhookEvents();
		this._toUnhook.dispose();
		this._didChangeConfigurationHandler.dispose();
		this._glyphWidget.dispose();
		this._contentWidget.dispose();
	}
}

class ShowHoverAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.showHover',
			label: nls.localize({
				key: 'showHover',
				comment: [
					'Label for action that will trigger the showing of a hover in the editor.',
					'This allows for users to show the hover without using the mouse.'
				]
			}, "Show Hover"),
			alias: 'Show Hover',
			precondition: undefined,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KEY_K, KeyMod.CtrlCmd | KeyCode.KEY_I),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor, args: { position?: IPosition, uri?: string, sticky?: boolean }): void {
		if (!editor.hasModel()) {
			return;
		}
		let finalEditor = editor;
		if (args.uri) {
			const codeEditorService = accessor.get(ICodeEditorService);
			const modelService = accessor.get(IModelService);
			const model = modelService.getModel(URI.parse(args.uri));
			if (model?.isAttachedToEditor()) {
				for (const editor of codeEditorService.listCodeEditors()) {
					if (editor.hasModel() && editor.getModel() === model && editor.hasTextFocus()) {
						finalEditor = editor;
						break;
					}
				}
			}
		}
		let controller = ModesHoverController.get(finalEditor);
		if (!controller) {
			return;
		}
		const position = args.position || finalEditor.getPosition();
		const range = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
		const focus = args.sticky || finalEditor.getOption(EditorOption.accessibilitySupport) === AccessibilitySupport.Enabled;
		controller.showContentHover(range, HoverStartMode.Immediate, focus, args.sticky);
	}
}

class ShowDefinitionPreviewHoverAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.showDefinitionPreviewHover',
			label: nls.localize({
				key: 'showDefinitionPreviewHover',
				comment: [
					'Label for action that will trigger the showing of definition preview hover in the editor.',
					'This allows for users to show the definition preview hover without using the mouse.'
				]
			}, "Show Definition Preview Hover"),
			alias: 'Show Definition Preview Hover',
			precondition: undefined
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		let controller = ModesHoverController.get(editor);
		if (!controller) {
			return;
		}
		const position = editor.getPosition();

		if (!position) {
			return;
		}

		const range = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
		const goto = GotoDefinitionAtPositionEditorContribution.get(editor);
		const promise = goto.startFindDefinitionFromCursor(position);
		if (promise) {
			promise.then(() => {
				controller.showContentHover(range, HoverStartMode.Immediate, true);
			});
		} else {
			controller.showContentHover(range, HoverStartMode.Immediate, true);
		}
	}
}

registerEditorContribution(ModesHoverController.ID, ModesHoverController);
registerEditorAction(ShowHoverAction);
registerEditorAction(ShowDefinitionPreviewHoverAction);

// theming
registerThemingParticipant((theme, collector) => {
	const editorHoverHighlightColor = theme.getColor(editorHoverHighlight);
	if (editorHoverHighlightColor) {
		collector.addRule(`.monaco-editor .hoverHighlight { background-color: ${editorHoverHighlightColor}; }`);
	}
	const hoverBackground = theme.getColor(editorHoverBackground);
	if (hoverBackground) {
		collector.addRule(`.monaco-editor .monaco-hover { background-color: ${hoverBackground}; }`);
	}
	const hoverBorder = theme.getColor(editorHoverBorder);
	if (hoverBorder) {
		collector.addRule(`.monaco-editor .monaco-hover { border: 1px solid ${hoverBorder}; }`);
		collector.addRule(`.monaco-editor .monaco-hover .hover-row:not(:first-child):not(:empty) { border-top: 1px solid ${hoverBorder.transparent(0.5)}; }`);
		collector.addRule(`.monaco-editor .monaco-hover hr { border-top: 1px solid ${hoverBorder.transparent(0.5)}; }`);
		collector.addRule(`.monaco-editor .monaco-hover hr { border-bottom: 0px solid ${hoverBorder.transparent(0.5)}; }`);
	}
	const link = theme.getColor(textLinkForeground);
	if (link) {
		collector.addRule(`.monaco-editor .monaco-hover a { color: ${link}; }`);
	}
	const hoverForeground = theme.getColor(editorHoverForeground);
	if (hoverForeground) {
		collector.addRule(`.monaco-editor .monaco-hover { color: ${hoverForeground}; }`);
	}
	const actionsBackground = theme.getColor(editorHoverStatusBarBackground);
	if (actionsBackground) {
		collector.addRule(`.monaco-editor .monaco-hover .hover-row .actions { background-color: ${actionsBackground}; }`);
	}
	const codeBackground = theme.getColor(textCodeBlockBackground);
	if (codeBackground) {
		collector.addRule(`.monaco-editor .monaco-hover code { background-color: ${codeBackground}; }`);
	}
});

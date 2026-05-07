import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Clock3, Forward, VolumeX, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WORKBENCH_ACTION_GRADIENT, WORKBENCH_ACTION_GRADIENT_HOVER } from "@/lib/theme";

import { useComposerPrefs } from "../useComposerPrefs";
import { STRINGS } from "../strings";

interface SendButtonGroupProps {
  canSend: boolean;
  onSend: () => void;
  onScheduleSend?: () => void;
}

export function SendButtonGroup({ canSend, onSend, onScheduleSend }: SendButtonGroupProps) {
  const [hover, setHover] = useState(false);
  const { prefs, setSilent, setJumpToNext } = useComposerPrefs();
  const mainLabel = prefs.silent ? STRINGS.composer.sendSilentMain : STRINGS.composer.send;
  const styleSend = canSend
    ? { background: hover ? WORKBENCH_ACTION_GRADIENT_HOVER : WORKBENCH_ACTION_GRADIENT }
    : undefined;
  const mainBtnCls = cn(
    "focus-ring h-9 rounded-l-md rounded-r-none px-5 text-wb-xs font-medium transition-all",
    canSend
      ? "text-workbench-text"
      : "bg-workbench-line text-workbench-text-muted disabled:opacity-100",
  );
  const chevronBtnCls = cn(
    "focus-ring h-9 rounded-l-none rounded-r-md border-l border-black/15 px-2 text-wb-xs font-medium transition-all dark:border-white/25",
    canSend
      ? "text-workbench-text"
      : "bg-workbench-line text-workbench-text-muted hover:bg-workbench-line-strong",
  );

  return (
    <div
      className="flex items-center"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Button
        type="button"
        disabled={!canSend}
        onClick={onSend}
        aria-label={mainLabel}
        className={mainBtnCls}
        style={styleSend}
      >
        {mainLabel}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            type="button"
            aria-label={STRINGS.composer.sendOptions}
            className={chevronBtnCls}
            style={styleSend}
          >
            <ChevronDown size={12} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-30 min-w-[200px] rounded-lg border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover-strong outline-none"
          >
            <Item
              icon={Zap}
              label={STRINGS.composer.sendImmediately}
              onSelect={onSend}
              disabled={!canSend}
            />
            <Item
              icon={Clock3}
              label={STRINGS.composer.sendSchedule}
              onSelect={() => onScheduleSend?.()}
              disabled={!onScheduleSend}
            />
            <DropdownMenu.Separator className="my-1 h-px bg-workbench-line" />
            <Toggle
              icon={VolumeX}
              label={STRINGS.composer.sendSilent}
              checked={prefs.silent}
              onChange={() => setSilent(!prefs.silent)}
            />
            <Toggle
              icon={Forward}
              label={STRINGS.composer.sendJumpToNext}
              checked={prefs.jumpToNext}
              onChange={() => setJumpToNext(!prefs.jumpToNext)}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function Item({
  icon: Icon,
  label,
  onSelect,
  disabled,
}: {
  icon: typeof Zap;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-wb-2xs text-workbench-text outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-workbench-surface-subtle data-[disabled]:opacity-50"
    >
      <Icon size={14} />
      <span>{label}</span>
    </DropdownMenu.Item>
  );
}

function Toggle({
  icon: Icon,
  label,
  checked,
  onChange,
}: {
  icon: typeof VolumeX;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onChange}
      onSelect={(e) => e.preventDefault()}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-wb-2xs text-workbench-text outline-none data-[highlighted]:bg-workbench-surface-subtle"
    >
      <Icon size={14} />
      <span className="flex-1">{label}</span>
      {checked && <Check size={14} className="text-workbench-accent" />}
    </DropdownMenu.CheckboxItem>
  );
}

import { useEffect, useState, useCallback } from 'react';

export type MidiDeviceInfo = {
    id: string;
    name: string;
    manufacturer: string;
    state: MIDIPortDeviceState;
};

type MidiDevicesState = {
    supported: boolean | null;          // null = not yet probed
    inputs: MidiDeviceInfo[];
    outputs: MidiDeviceInfo[];
    selectedInputId: string | null;
    selectedOutputId: string | null;
};

const portToInfo = (port: MIDIPort): MidiDeviceInfo => ({
    id: port.id,
    name: port.name ?? '(unnamed)',
    manufacturer: port.manufacturer ?? '',
    state: port.state,
});

export const useMidiDevices = () => {
    const [state, setState] = useState<MidiDevicesState>({
        supported: null,
        inputs: [],
        outputs: [],
        selectedInputId: null,
        selectedOutputId: null,
    });

    useEffect(() => {
        if (!navigator.requestMIDIAccess) {
            setState(s => ({ ...s, supported: false }));
            return;
        }

        let cancelled = false;

        const refresh = (access: MIDIAccess) => {
            if (cancelled) return;
            const inputs = Array.from(access.inputs.values()).map(portToInfo);
            const outputs = Array.from(access.outputs.values()).map(portToInfo);

            setState(prev => {
                // Auto-select first connected device if nothing selected or current selection vanished
                const inputIds = new Set(inputs.map(d => d.id));
                const outputIds = new Set(outputs.map(d => d.id));

                let selectedInputId = prev.selectedInputId;
                if (!selectedInputId || !inputIds.has(selectedInputId)) {
                    selectedInputId = inputs.find(d => d.state === 'connected')?.id ?? null;
                }

                let selectedOutputId = prev.selectedOutputId;
                if (!selectedOutputId || !outputIds.has(selectedOutputId)) {
                    selectedOutputId = outputs.find(d => d.state === 'connected')?.id ?? null;
                }

                return { supported: true, inputs, outputs, selectedInputId, selectedOutputId };
            });
        };

        void (async () => {
            try {
                const access = await navigator.requestMIDIAccess({ sysex: false });
                if (cancelled) return;
                refresh(access);
                access.onstatechange = () => refresh(access);
            } catch {
                if (!cancelled) setState(s => ({ ...s, supported: false }));
            }
        })();

        return () => { cancelled = true; };
    }, []);

    const setSelectedInputId = useCallback((id: string) => {
        setState(s => ({ ...s, selectedInputId: id }));
    }, []);

    const setSelectedOutputId = useCallback((id: string) => {
        setState(s => ({ ...s, selectedOutputId: id }));
    }, []);

    return {
        ...state,
        setSelectedInputId,
        setSelectedOutputId,
    };
};

import { MPM } from "mpm-ts";
import { importWork, MSM } from "mpmify";
import { DynamicsTransformerOptions, reprojectPhantomVelocities } from "../dynamicsSafety";
import { reprojectSilentOnsets, sanitizeTempoInstructions, TempoTransformerOptions } from "../tempoSafety";

type MpmifyOptions = {
    referenceMsm?: MSM;
    log?: (msg: string) => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mpmify = (msm: MSM, infoJson: any, options: MpmifyOptions = {}): MPM => {
    const mpm = new MPM();
    const { transformers } = importWork(infoJson);
    transformers.forEach(transformer => {
        if (options.referenceMsm && transformer.name === 'InsertDynamicsInstructions') {
            const dynamicsOptions = transformer.options as DynamicsTransformerOptions | undefined;
            if (dynamicsOptions?.phantomVelocities instanceof Map && dynamicsOptions.phantomVelocities.size > 0) {
                dynamicsOptions.phantomVelocities = reprojectPhantomVelocities(
                    dynamicsOptions,
                    options.referenceMsm,
                    msm,
                    options.log,
                );
            }
        }

        if (options.referenceMsm && transformer.name === 'ApproximateLogarithmicTempo') {
            const tempoOptions = transformer.options as TempoTransformerOptions | undefined;
            if (tempoOptions && Array.isArray(tempoOptions.silentOnsets) && tempoOptions.silentOnsets.length > 0) {
                tempoOptions.silentOnsets = reprojectSilentOnsets(
                    tempoOptions,
                    options.referenceMsm,
                    msm,
                    options.log,
                );
            }
        }

        transformer.run(msm, mpm);

        if (transformer.name === 'ApproximateLogarithmicTempo') {
            const tempoOptions = transformer.options as TempoTransformerOptions | undefined;
            sanitizeTempoInstructions(mpm, tempoOptions?.scope, options.log);
        }
    });
    return mpm;
};

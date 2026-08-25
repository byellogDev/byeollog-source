/*
 * Byeollog Voice Filter for OBS Studio
 * Copyright (C) 2026 Byeollog
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version.
 */

#include <obs-module.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include <signalsmith-stretch.h>

namespace {

constexpr char kFilterId[] = "byeollog_voice_filter_v1";
constexpr char kSemitonesSetting[] = "semitones";
constexpr float kMinimumSemitones = -12.0f;
constexpr float kMaximumSemitones = 12.0f;
constexpr uint32_t kCrossfadeMilliseconds = 24;

using PitchEngine = signalsmith::stretch::SignalsmithStretch<float>;

struct VoiceFilter {
    PitchEngine engine;
    uint32_t channels = 0;
    uint32_t sampleRate = 0;
    uint64_t processedFrames = 0;
    uint64_t warmupFrames = 0;
    uint64_t crossfadeFrames = 0;
    std::vector<std::vector<float>> output;
    std::vector<float *> inputPointers;
    std::vector<float *> outputPointers;

    VoiceFilter(uint32_t channelCount, uint32_t rate, float semitones)
        : channels(channelCount), sampleRate(rate), output(channelCount),
          inputPointers(channelCount), outputPointers(channelCount)
    {
        engine.presetCheaper(static_cast<int>(channels), static_cast<float>(sampleRate), true);
        engine.setTransposeSemitones(semitones);
        warmupFrames = static_cast<uint64_t>(std::max(0, engine.inputLatency()))
            + static_cast<uint64_t>(std::max(0, engine.outputLatency()));
        crossfadeFrames = std::max<uint64_t>(
            1,
            static_cast<uint64_t>(sampleRate) * kCrossfadeMilliseconds / 1000);
    }

    void setSemitones(float semitones)
    {
        engine.setTransposeSemitones(std::clamp(
            semitones,
            kMinimumSemitones,
            kMaximumSemitones));
    }
};

float readSemitones(obs_data_t *settings)
{
    const double value = obs_data_get_double(settings, kSemitonesSetting);
    if (!std::isfinite(value))
        return -4.0f;
    return std::clamp(
        static_cast<float>(value),
        kMinimumSemitones,
        kMaximumSemitones);
}

const char *filterName(void *)
{
    return "별록 신원보호 음성 필터";
}

void filterDefaults(obs_data_t *settings)
{
    obs_data_set_default_double(settings, kSemitonesSetting, -4.0);
}

void *filterCreate(obs_data_t *settings, obs_source_t *)
{
    try {
        obs_audio_info audioInfo{};
        if (!obs_get_audio_info(&audioInfo) || audioInfo.samples_per_sec == 0)
            return nullptr;
        const uint32_t channels = get_audio_channels(audioInfo.speakers);
        if (channels == 0 || channels > MAX_AV_PLANES)
            return nullptr;
        return new VoiceFilter(channels, audioInfo.samples_per_sec, readSemitones(settings));
    } catch (...) {
        return nullptr;
    }
}

void filterDestroy(void *data)
{
    delete static_cast<VoiceFilter *>(data);
}

void filterUpdate(void *data, obs_data_t *settings)
{
    if (!data || !settings)
        return;
    try {
        static_cast<VoiceFilter *>(data)->setSemitones(readSemitones(settings));
    } catch (...) {
        // Never let a DSP exception cross the OBS C ABI boundary.
    }
}

obs_audio_data *filterAudio(void *data, obs_audio_data *audio)
{
    if (!data || !audio || audio->frames == 0)
        return audio;

    auto *filter = static_cast<VoiceFilter *>(data);
    try {
        for (uint32_t channel = 0; channel < filter->channels; ++channel) {
            if (!audio->data[channel])
                return audio;
            filter->output[channel].resize(audio->frames);
            filter->inputPointers[channel] = reinterpret_cast<float *>(audio->data[channel]);
            filter->outputPointers[channel] = filter->output[channel].data();
        }

        filter->engine.process(
            filter->inputPointers.data(),
            static_cast<int>(audio->frames),
            filter->outputPointers.data(),
            static_cast<int>(audio->frames));

        const uint64_t blockStart = filter->processedFrames;
        filter->processedFrames += audio->frames;
        if (filter->processedFrames <= filter->warmupFrames)
            return audio;

        for (uint32_t channel = 0; channel < filter->channels; ++channel) {
            float *dry = reinterpret_cast<float *>(audio->data[channel]);
            const float *wet = filter->output[channel].data();
            for (uint32_t frame = 0; frame < audio->frames; ++frame) {
                const uint64_t absoluteFrame = blockStart + frame;
                float mix = 1.0f;
                if (absoluteFrame < filter->warmupFrames) {
                    mix = 0.0f;
                } else if (absoluteFrame < filter->warmupFrames + filter->crossfadeFrames) {
                    mix = static_cast<float>(absoluteFrame - filter->warmupFrames)
                        / static_cast<float>(filter->crossfadeFrames);
                }
                dry[frame] = dry[frame] + (wet[frame] - dry[frame]) * mix;
            }
        }
    } catch (...) {
        return audio;
    }
    return audio;
}

obs_source_info makeFilterInfo()
{
    obs_source_info info{};
    info.id = kFilterId;
    info.type = OBS_SOURCE_TYPE_FILTER;
    info.output_flags = OBS_SOURCE_AUDIO;
    info.get_name = filterName;
    info.create = filterCreate;
    info.destroy = filterDestroy;
    info.get_defaults = filterDefaults;
    info.update = filterUpdate;
    info.filter_audio = filterAudio;
    return info;
}

obs_module_t *modulePointer = nullptr;

} // namespace

extern "C" __declspec(dllexport) void obs_module_set_pointer(obs_module_t *module)
{
    modulePointer = module;
}

extern "C" __declspec(dllexport) uint32_t obs_module_ver(void)
{
    // The filter only uses APIs available in OBS 30.2 and is intentionally
    // loadable by OBS 30.2+ even when compiled with newer local headers.
    return MAKE_SEMANTIC_VERSION(30, 2, 0);
}

extern "C" __declspec(dllexport) const char *obs_module_name(void)
{
    return "Byeollog Voice Filter";
}

extern "C" __declspec(dllexport) const char *obs_module_description(void)
{
    return "Pitch-shift filter used locally by Byeollog identity protection mode.";
}

extern "C" __declspec(dllexport) const char *obs_module_author(void)
{
    return "Byeollog";
}

extern "C" __declspec(dllexport) bool obs_module_load(void)
{
    static obs_source_info filterInfo = makeFilterInfo();
    obs_register_source_s(&filterInfo, sizeof(filterInfo));
    return true;
}

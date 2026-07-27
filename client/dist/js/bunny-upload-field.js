/**
 * BunnyUploadField client behaviour.
 *
 * Initialises each .bunny-upload-field wrapper:
 *  - Wires the Ontkoppelen button to clear the relation
 *  - Drives direct-to-Bunny TUS uploads (tus-js-client must be loaded by PHP)
 *  - Lets the user attach an already-uploaded video (loaded on demand from the
 *    listVideos endpoint) instead of re-uploading
 *  - Notifies UncleCheese DisplayLogic when the hidden BunnyVideoID value
 *    changes (its JS only listens to text/email/number inputs natively, so
 *    we trigger .notify() on the dispatcher wrapper ourselves)
 *
 * Loaded as a static file via Requirements::javascript() so SS admin's
 * React-driven AJAX form swaps pick it up cleanly; inline <script> tags in
 * the field's Field() output break script ordering and don't execute on
 * panel navigation anyway.
 */
(function() {
    // Minimal DisplayLogic evaluator. The CMS-loaded jquery.entwine isn't
    // reachable from our standalone script (window.jQuery has no entwine
    // methods — different jQuery instance under webpack), so we can't call
    // its $dispatcher.notify() / $wrapper.testLogic() to re-sync visibility
    // after a programmatic value change.
    //
    // Instead: find every .displaylogicwrapper in the form, evaluate its
    // `data-display-logic-eval` expression manually, and toggle display
    // accordingly. The eval strings use only `this.findHolder('X').evaluateY('Z')`
    // — we mirror just enough of that surface to keep the wrappers honest.
    function buildEvaluator(form) {
        return {
            findHolder: function (name) {
                // Holder ID convention: {FormID}_{FieldName}_Holder
                var formId = form.getAttribute('id') || '';
                var holder = form.querySelector('#' + formId + '_' + name + '_Holder');
                var input = holder ? holder.querySelector('[name="' + name + '"]') : null;
                if (!input) input = form.querySelector('[name="' + name + '"]');
                var val = input ? (input.value || '') : '';
                return {
                    evaluateEmpty: function () { return val.trim() === ''; },
                    evaluateNotEmpty: function () { return val.trim() !== ''; },
                    evaluateEqualTo: function (v) { return val === v; },
                    evaluateNotEqualTo: function (v) { return val !== v; },
                    evaluateGreaterThan: function (v) { return parseFloat(val) > parseFloat(v); },
                    evaluateLessThan: function (v) { return parseFloat(val) < parseFloat(v); },
                    evaluateContains: function (v) { return val.indexOf(v) !== -1; },
                    evaluateStartsWith: function (v) { return val.indexOf(v) === 0; },
                    evaluateEndsWith: function (v) { return val.indexOf(v, val.length - v.length) !== -1; },
                };
            }
        };
    }

    function resyncDisplayLogic(input) {
        var form = input.closest('form');
        if (!form) return;
        var evaluator = buildEvaluator(form);
        var wrappers = form.querySelectorAll('.displaylogicwrapper');
        wrappers.forEach(function (wrapper) {
            var evalStr = wrapper.getAttribute('data-display-logic-eval');
            if (!evalStr) return;
            var result;
            try {
                // eslint-disable-next-line no-new-func
                result = (new Function('return ' + evalStr)).call(evaluator);
            } catch (e) {
                return; // unknown criterion → leave wrapper alone
            }
            // .display-logic-hide → hide when criteria TRUE
            // .display-logic-display → show when criteria TRUE
            if (wrapper.classList.contains('display-logic-hide')) {
                wrapper.style.display = result ? 'none' : '';
            } else if (wrapper.classList.contains('display-logic-display')) {
                wrapper.style.display = result ? '' : 'none';
            }
        });
    }

    function notifyDisplayLogic(input) {
        // Try the standard entwine path first (works in some contexts).
        if (window.jQuery) {
            try {
                var $dispatcher = window.jQuery(input).closest('.display-logic-dispatcher');
                if ($dispatcher.length && typeof $dispatcher.notify === 'function') {
                    $dispatcher.notify();
                }
            } catch (e) { /* fall through */ }
        }
        // Always do our own resync — independent of whether entwine bound.
        resyncDisplayLogic(input);
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Build the same preview markup the PHP Field() renders server-side, so a
    // client-selected existing video looks identical to a reloaded one.
    function buildPreviewHtml(fieldId, video) {
        var poster = video.thumbnailUrl
            ? '<img src="' + escapeHtml(video.thumbnailUrl) + '" alt="" style="max-width:160px; max-height:90px; border-radius:4px; object-fit:cover;" class="me-3 mr-3" onerror="this.style.display=\'none\'">'
            : '';
        var statusClass = video.isReady ? 'text-success' : 'text-warning';
        var duration = video.duration
            ? '<small class="text-muted ms-2 ml-2">' + escapeHtml(video.duration) + '</small>'
            : '';
        var editBtn = video.editUrl
            ? '<a href="' + escapeHtml(video.editUrl) + '" target="_blank" class="btn btn-sm btn-outline-secondary ms-2 ml-2" title="Video openen in het videobeheer (nieuw tabblad)">'
              + '<i class="font-icon-edit"></i> Bewerken'
              + '</a>'
            : '';

        return '<div id="' + fieldId + '_preview" class="d-flex align-items-center p-2 border rounded" style="background:#f8f9fa;">'
            + poster
            + '<div class="flex-grow-1">'
            + '<div class="fw-semibold font-weight-bold">' + escapeHtml(video.title) + '</div>'
            + '<small class="' + statusClass + '">' + escapeHtml(video.status) + '</small>'
            + duration
            + '</div>'
            + editBtn
            + '<button type="button" id="' + fieldId + '_remove" class="btn btn-sm btn-outline-danger ms-2 ml-2" title="Video ontkoppelen">'
            + '<i class="font-icon-link-broken"></i> Ontkoppelen'
            + '</button>'
            + '</div>';
    }

    function init(wrapper) {
        if (wrapper.dataset.bunnyInit) return;
        wrapper.dataset.bunnyInit = '1';

        var fieldId = wrapper.dataset.fieldId;
        var createUrl = wrapper.dataset.createUrl;
        var listUrl = wrapper.dataset.listUrl;
        // Upload-only mode (VideoAdmin "add new"): no relation to store, no
        // existing-video picker — on success redirect to the new record's edit form.
        var uploadOnly = wrapper.dataset.uploadOnly === '1';
        if (!fieldId || !createUrl) return;

        var fileInput = document.getElementById(fieldId + '_file');
        var uploadBtn = document.getElementById(fieldId + '_btn');
        var statusEl = document.getElementById(fieldId + '_status');
        var progressEl = document.getElementById(fieldId + '_progress');
        var progressBar = progressEl ? progressEl.querySelector('.progress-bar') : null;
        var resultEl = document.getElementById(fieldId + '_result');
        var hiddenInput = document.getElementById(fieldId);
        var uploadWrap = document.getElementById(fieldId + '_upload');
        var existingSelect = document.getElementById(fieldId + '_existing');
        var existingBtn = document.getElementById(fieldId + '_existing_btn');

        // Set the hidden value AND wake up DisplayLogic + any other listeners.
        // Native dispatchEvent reaches addEventListener handlers; jQuery .trigger()
        // is needed for jQuery-bound entwine handlers (SS DisplayLogic uses these
        // and won't see purely-native events on hidden inputs).
        function setVideoId(val) {
            hiddenInput.value = val;
            hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) {
                window.jQuery(hiddenInput).trigger('change');
            }
            notifyDisplayLogic(hiddenInput);
        }

        // Detach the current video: clear the value, drop any preview, and
        // reveal the upload/select UI again.
        function detachVideo() {
            setVideoId('');
            var preview = document.getElementById(fieldId + '_preview');
            if (preview) preview.parentNode.removeChild(preview);
            if (existingSelect) existingSelect.value = '';
            if (existingBtn) existingBtn.disabled = true;
            if (resultEl) { resultEl.style.display = 'none'; resultEl.textContent = ''; }
            if (uploadWrap) uploadWrap.style.display = 'block';
        }

        // (Re)bind the Ontkoppelen button — the preview can be server-rendered
        // at load or client-inserted after selecting an existing video.
        function bindRemove() {
            var removeBtn = document.getElementById(fieldId + '_remove');
            if (removeBtn && !removeBtn.dataset.bound) {
                removeBtn.dataset.bound = '1';
                removeBtn.addEventListener('click', detachVideo);
            }
        }
        bindRemove();

        // Attach an existing video: insert a preview, hide the upload UI, store id.
        function attachExisting(video) {
            var existingPreview = document.getElementById(fieldId + '_preview');
            if (existingPreview) existingPreview.parentNode.removeChild(existingPreview);

            hiddenInput.insertAdjacentHTML('afterend', buildPreviewHtml(fieldId, video));
            bindRemove();
            setVideoId(video.id);
            if (uploadWrap) uploadWrap.style.display = 'none';
        }

        // Lazy-load the existing-video list on first interaction with the select.
        if (existingSelect && existingBtn && listUrl) {
            var videosById = {};
            var listLoaded = false;

            function loadList() {
                if (listLoaded) return;
                listLoaded = true;
                existingSelect.disabled = true;
                fetch(listUrl, {
                    credentials: 'same-origin',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                })
                .then(function(r) { return r.json(); })
                .then(function(videos) {
                    (videos || []).forEach(function(video) {
                        videosById[video.id] = video;
                        var opt = document.createElement('option');
                        opt.value = video.id;
                        var label = video.title || ('Video #' + video.id);
                        var meta = [video.status, video.duration].filter(Boolean).join(' · ');
                        opt.textContent = meta ? (label + ' (' + meta + ')') : label;
                        existingSelect.appendChild(opt);
                    });
                    existingSelect.disabled = false;
                })
                .catch(function() {
                    listLoaded = false; // allow a retry on next interaction
                    existingSelect.disabled = false;
                });
            }

            existingSelect.addEventListener('focus', loadList);
            existingSelect.addEventListener('change', function() {
                existingBtn.disabled = !existingSelect.value;
            });

            existingBtn.addEventListener('click', function() {
                var video = videosById[existingSelect.value];
                if (video) attachExisting(video);
            });
        }

        if (!fileInput || !uploadBtn) return;

        fileInput.addEventListener('change', function() {
            uploadBtn.disabled = !fileInput.files.length;
            if (statusEl) statusEl.textContent = fileInput.files.length ? fileInput.files[0].name : '';
        });

        uploadBtn.addEventListener('click', function() {
            var file = fileInput.files[0];
            if (!file) return;

            uploadBtn.disabled = true;
            fileInput.disabled = true;
            if (statusEl) statusEl.textContent = 'Voorbereiden...';
            if (progressEl) progressEl.style.display = 'block';

            fetch(createUrl + '?title=' + encodeURIComponent(file.name), {
                credentials: 'same-origin',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (!data.tusEndpoint) throw new Error('Geen upload endpoint ontvangen');
                if (statusEl) statusEl.textContent = 'Uploaden...';

                var upload = new tus.Upload(file, {
                    endpoint: data.tusEndpoint,
                    retryDelays: [0, 1000, 3000, 5000],
                    chunkSize: 25 * 1024 * 1024,
                    headers: data.tusHeaders,
                    metadata: { filetype: file.type, title: file.name },
                    onError: function(error) {
                        if (statusEl) statusEl.textContent = 'Upload mislukt: ' + error.message;
                        uploadBtn.disabled = false;
                        fileInput.disabled = false;
                        if (progressEl) progressEl.style.display = 'none';
                    },
                    onProgress: function(bytesUploaded, bytesTotal) {
                        var pct = Math.round(bytesUploaded / bytesTotal * 100);
                        if (progressBar) {
                            progressBar.style.width = pct + '%';
                            progressBar.textContent = pct + '%';
                        }
                    },
                    onSuccess: function() {
                        // Upload-only: the BunnyVideo already exists server-side.
                        // Redirect straight to its edit form. We never touched any
                        // form field, so the create form stays pristine — no
                        // "unsaved changes" prompt blocks the navigation.
                        if (uploadOnly) {
                            if (progressBar) {
                                progressBar.style.width = '100%';
                                progressBar.textContent = '100%';
                                progressBar.classList.add('bg-success');
                            }
                            if (statusEl) statusEl.textContent = 'Video geüpload — bezig met openen...';
                            if (data.editUrl) {
                                window.location.href = data.editUrl;
                            } else if (resultEl) {
                                resultEl.textContent = 'Video geüpload en toegevoegd aan de lijst.';
                                resultEl.style.display = 'block';
                            }
                            return;
                        }
                        setVideoId(data.bunnyVideoId);
                        if (progressBar) {
                            progressBar.style.width = '100%';
                            progressBar.textContent = '100%';
                            progressBar.classList.add('bg-success');
                        }
                        if (statusEl) statusEl.textContent = '';
                        if (resultEl) {
                            resultEl.textContent = 'Video geüpload — sla deze vraag op om de koppeling te bevestigen';
                            resultEl.style.display = 'block';
                        }
                        // Lock the upload UI so another file can't be picked while a video is pending.
                        fileInput.disabled = true;
                        uploadBtn.disabled = true;
                    }
                });

                upload.start();
            })
            .catch(function(err) {
                if (statusEl) statusEl.textContent = 'Fout: ' + err.message;
                uploadBtn.disabled = false;
                fileInput.disabled = false;
                if (progressEl) progressEl.style.display = 'none';
            });
        });
    }

    function scan() {
        document.querySelectorAll('.bunny-upload-field').forEach(init);
    }

    // Initial scan + observer so AJAX-loaded form fields get picked up.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan);
    } else {
        scan();
    }
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
})();
